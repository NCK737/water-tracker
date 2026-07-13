// dotenv read the .env file & loads its values into process.env
// require() is Node's way of loading a package or built in module to use it.
require('dotenv').config();

const express = require('express'); // A framework making it ez to handle web requests.
const { Pool } = require('pg');

const app = express(); // express() created application project
const PORT = process.env.PORT || 3000;

//----- Database Setup -----
// A Pool manages a small set of ready-to-use connections
// handing one out per request instead of opening a new connection
// every time (which would be slow)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Neon requires an encrypted SSL connection
});

// Creates table if it doesn't exist. This is async as it's a
// network call - we await it once before the server starts
// accepting requests
async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS drinks (
            id SERIAL PRIMARY KEY,
            amount_ml INTEGER NOT NULL,
            logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

// ----- Database helper functions -----
// These repolace the old db.prepare(...)
// Each one is async cux every call is a network round trip to Neon's servers.
async function insertDrink(amount) {
    await pool.query('INSERT INTO drinks (amount_ml) VALUES ($1)', [amount]);
}

async function deleteDrinkById(id) {
    await pool.query('DELETE FROM drinks WHERE id = $1', [id]);
}

// One query fetches everything from last 8 days.
// We do the today's total and last 7 days grouping in JS
async function fetchRecentRows() {
    const result = await pool.query(
        `SELECT id, amount_ml, logged_at FROM drinks
        WHERE logged_at >= NOW() - INTERVAL '8 days'
        ORDER BY id DESC`
    );
    return result.rows;
}

//----- Daily Goal -----
const DAILY_GOAL_ML = 2000;

const TIMEZONE = 'Europe/London';

app.use(express.json()); // app.use() registers middleware - code that runs on every incoming request before reaching route handlers.
app.use(express.urlencoded({extended: true}));

//----- Shared page shell -----
function pageShell(bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Water Tracker</title>
<style>
    :root {
        --blue: #2563eb;
        --light: #eff6ff;
        --text: #1e293b;
        --muted: #64748b;
    }
    * { box-sizing: border-box;}
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: linear-gradient(180deg, #eff6ff 0%, #ffffff 200px);
        margin: 0;
        padding: 24px 16px;
        color: var(--text);
    }
    .container { max-width: 480px; margin: 0 auto;}
    h1 { font-size: 22px; margin-bottom: 4px;}
    .subtitle {color: var(--muted); font-size: 14px; margin-bottom: 24px;}
    .card {
        background: white;
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        margin-bottom: 16px;
    }
    .total {
        font-size: 42px;
        font-weight: 700;
        color: var(--blue);
    }
    .total-sub { color: var(--muted); font-size: 14px;}
    .progress-track {
        background: var(--light);
        border-radius: 999px;
        height: 12px;
        margin-top: 12px;
        overflow: hidden;
    }
    .progress-fill {
        background: var(--blue);
        height: 100%;
        border-radius: 999px;
        transition: width 0.3s ease;
    }
    .buttons {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin-top: 8px;
    }
    .btn {
        display: block;
        text-align: center;
        background: var(--blue);
        color: white;
        text-decoration: none;
        padding: 16px;
        border-radius: 12px;
        font-size: 16px;
        font-weight: 600;
        border: none;
        cursor: pointer;
    }
    .btn.secondary {
        background: var(--light);
        color: var(--blue);
    }
    form.custom {display: flex; gap: 8px; margin-top: 12px;}
    input[type=number] {
        flex: 1;
        padding: 12px;
        border-radius: 10px;
        border: 1px solid #cbd5e1;
        font-size: 16px;
    }
    .history-item {
        display: flex;
        justify-content: space-between;
        padding: 8px 0;
        border-bottom: 1px solid #f1f5f9;
        font-size: 14px;
    }
    .history-item:last-child {border-bottom: none;}
    .delete-link {
        color: #cbd5e1;
        text-decoration:none;
        margin-left: 8px;
        font-size: 13px;
    }
    .delete-link:hover {color: #ef4444;}
    .muted {color: var(--muted);}
    .confirm {
        text-align: center;
        padding: 32px 0;
    }
    .confirm .big {font-size: 48px; margin-bottom: 8px;}
    a.link-back { color: var(--blue); text-decoration: none; font-size: 14px;}
    .bars { display: flex; align-items: flex-end; gap: 6px; height: 80px; margin-top: 12px;}
    .bar { flex: 1; background: var(--light); border-radius: 4px;position: relative;}
    .bar-fill {background: var(--blue); border-radius: 4px; width:100%; position: absolute; bottom: 0;}
    .bar-label { font-size: 10px; color: var(--muted); text-align: center; margin-top: 4px;}
    .error-banner {
        background: #fef2f2;
        color: #b91c1c;
        padding: 12px 16px;
        border-radius: 12px;
        font-size:14px;
        margin-bottom: 16px;
    }
</style>
</head>
<body>
<div class="container">
${bodyHtml}
</div>
</body>
</html>`;
}

// ----- Small helpers for turning rows into the dashboard's numbers -----
// These run entirely in JS on data already fetched
// Instead of asking postgres to do more math

function dateKey(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function summarise(rows) {
    const todayKey = dateKey(new Date());
    let todayTotal = 0;
    const totalsByDay = {};

    rows.forEach(row => {
        const rowDate = new Date(row.logged_at);
        const key = dateKey(rowDate);
        totalsByDay[key] = (totalsByDay[key] || 0) + row.amount_ml;
        if (key === todayKey) todayTotal += row.amount_ml;
    });
    return { todayTotal, totalsByDay };
}

// ----- Routes -----

// Dashboard / Home Page
app.get('/', async (req, res) => {
    try {
        const rows = await fetchRecentRows();
        const { todayTotal, totalsByDay } = summarise(rows);
        const pct = Math.min(100, Math.round((todayTotal / DAILY_GOAL_ML) * 100));
        const recent = rows.slice(0, 15);

        const historyHtml = recent.length
            ? recent.map(d => `
                <div class="history-item">
                    <span>${d.amount_ml} ml</span>
                    <span>
                        <span class="muted">${new Date(d.logged_at).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span>
                        <a href="/delete/${d.id}" class="delete-link" title="Delete this entry">✕</a>
                    </span>
                </div>`).join('')
            : '<p class="muted">No drinks logged yet.</p>';
        
        const maxDay = Math.max(DAILY_GOAL_ML, ...Object.values(totalsByDay), 1);

        const last7DayKeys = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            last7DayKeys.push(dateKey(d));
        }

        const barsHtml = last7DayKeys.map(key => {
            const total = totalsByDay[key] || 0;
            const h = total > 0 ? Math.max(4, Math.round((total / maxDay) * 80)): 0;
            const label = new Date(key).toLocaleDateString([], {weekday: 'short'});
            return `<div style="display:flex;flex-direction:column;flex:1;">
                <div class="bar" style="height:80px;">
                    <div class="bar-fill" style="height:${h}px;"></div>
                </div>
                <div class="bar-label">${label}</div>
            </div>`;
        }).join('');

        res.send(pageShell(`
            <h1>💧 Water Tracker</h1>
            <p class="subtitle">Tap your NFC tag to log a drink!</p>
        
            <div class="card">
                <div class="total">${todayTotal} <span style="font-size: 20px;">ml</span></div>
                <div class="total-sub">of ${DAILY_GOAL_ML} ml goal (${pct}%)</div>
                <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
                ${recent.length ? '<a href="/undo" class="link-back" style="display:inline-block;margin-top:12px;">↩ Undo last drink</a>' : ''}
            </div>
            
            <div class="card">
                <p style="margin-top:0;font-weight:600;">Quick log</p>
                <div class="buttons">
                    <a class="btn" href="/log/100">+100 ml</a>
                    <a class="btn" href="/log/250">+250 ml</a>
                    <a class="btn" href="/log/300">+300 ml</a>
                    <a class="btn" href="/log/500">+500 ml</a>
                    <a class="btn" href="/log/1000">+ 1 L</a>
                    <a class="btn" href="/log/2000">+ 2 L</a>
                </div>
                <form class="custom" action="/log-custom" method="GET">
                    <input type="number" name="amount" placeholder="Custom ml" min="1" required>
                    <button class="btn-secondary" type="submit" style="width:auto;padding:12px 20px;">Log</button>
                </form>
            </div>

            <div class="card">
                <p style="margin-top:0;font-weight:600;">Last 7 Days</p>
                <div class="bars">${barsHtml}</div>
            </div>
            
            <div class="card">
                <p style="margin-top:0;font-weight:600;">Recent Activity</p>
                ${historyHtml}
            </div>
        `));
    } catch (err) {
        console.error('Failed to load dashboard:', err);
        res.status(500).send(pageShell(`
            <div class="error-banner">Couldn't reach the database. Check your DATABASE_URL and try again.</div>
        `));
    }
});

// This is the route NFC tag should point to for a fixed amount
// e.g. https://yourdomain.com/log/500
app.get('/log/:amount', async (req, res) => {
    const amount = parseInt(req.params.amount, 10);
    if (!Number.isFinite(amount) || amount <=0 || amount > 5000) {
        return res.status(400).send(pageShell('<p>Invalid amount.</p><a class="link-back" href="/">Back</a>'));
    }
    try {
        await insertDrink(amount);
        const rows = await fetchRecentRows();
        const { todayTotal } = summarise(rows);
        const pct = Math.min(100, Math.round((todayTotal / DAILY_GOAL_ML) * 100));

        res.send(pageShell(`
            <div class="confirm">
                <div class="big">✅</div>
                <h1>Logged ${amount} ml</h1>
                <p class="subtitle">Today's total: <strong>${todayTotal} ml</strong> (${pct}% of goal)</p>
                <a class="link-back" href="/">View dashboard →</a>
            </div>
        `));
    } catch (err) {
        console.error('Failed to log drink:', err);
        res.status(500).send(pageShell('div class="error-banner">Something went wrong saving that. Please try again.</div>'));
    }
});

// Custom amount via form on the dashboard
app.get('/log-custom', async (req, res) => {
    const amount = parseInt(req.query.amount, 10);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) {
        return res.redirect('/');
    }
    try {
        await insertDrink(amount);
    } catch (err) {
        console.log('Failed to log custom amount:', err);
    }
    res.redirect('/');
});

// JSON API, useful for a proper app/widget later
app.get('/api/today', async (req, res) => {
    try {
        const rows = await fetchRecentRows();
        const { todayTotal } = summarise(rows);
        res.json({ total_ml: todayTotal, goal_ml: DAILY_GOAL_ML });
    } catch (err) {
        res.status(500).json({ error: 'database error' });
    }
});

app.post('/api/log', async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({error: 'invalid amount'});
    }
    try {
        await insertDrink(amount);
        const rows = await fetchRecentRows();
        const { todayTotal } = summarise(rows);
        res.json({ ok: true, total_ml: todayTotal });
    } catch (err) {
        res.status(500).json({ error: 'database error' });
    }
});

// Delete a single entry by its id
app.get('/delete/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isFinite(id)) {
        try {
            await deleteDrinkById(id);
        } catch (err) {
            console.error('Failed to delete entry:', err);
        }
    }
    res.redirect('/');
});

app.get('/undo', async (req, res) => {
    try {
        const rows = await fetchRecentRows();
        if (rows.length > 0) {
            await deleteDrinkById(rows[0].id);
        }
    } catch (err) {
        console.error('Failed to undo:', err);
    }
    res.redirect('/');
});

// Undo the most recent entry
app.post('/api/aundo-last', async (req, res) => {
    try {
        const rows = await fetchRecentRows();
        if (rows.length > 0) {
            await deleteDrinkById(rows[0].id);
        }
        res.json({ok: true});
    } catch (err) {
        res.status(500).json({ error: 'database error' });
    }
});

// ----- STARTUP -----
// Wrap startup in an async function to `await` the table
// creation BEFORE the server starts accepting requests. Without this,
// there's a small window where a request could arrive before the
// `drinks` table exists yet.
async function start() {
    try {
        await setupDatabase();
        app.listen(PORT, () => {
            console.log(`Water tracking running at http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server - check your DATABASE_URL:', err);
        process.exit(1);
    }
}

start();