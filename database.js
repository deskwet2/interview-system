const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the SQLite database file (it will be created if it doesn't exist)
const db = new sqlite3.Database(path.join(__dirname, 'interview_system.db'), (err) => {
    if (err) console.error("Database connection error:", err.message);
    else console.log("Connected to the SQLite database.");
});

const initDb = () => {
    db.serialize(() => {
        // 1. Categories Table (Points 1 & 4)
        db.run(`CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            default_redirect_url TEXT
        )`);

        // 2. Screens Table (Point 2)
        db.run(`CREATE TABLE IF NOT EXISTS screens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER,
            screen_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            is_default INTEGER DEFAULT 0,
            FOREIGN KEY (category_id) REFERENCES categories (id)
        )`);

        // 3. Candidates Table (Points 6, 7 & 8)
        // Using EMAIL as PRIMARY KEY to solve the refresh bug
        db.run(`CREATE TABLE IF NOT EXISTS candidates (
            email TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category_id INTEGER,
            status TEXT DEFAULT 'live',
            last_connected DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories (id)
        )`);

        // 4. Interactions Table (Point 3)
        // Stores the full transcript/history of commands and responses
        db.run(`CREATE TABLE IF NOT EXISTS interactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            candidate_email TEXT,
            type TEXT CHECK(type IN ('command', 'response')),
            screen_file TEXT,
            content TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (candidate_email) REFERENCES candidates (email)
        )`);
        
        console.log("All database tables initialized.");
    });
};

module.exports = { db, initDb };