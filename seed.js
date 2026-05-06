const { db, initDb } = require('./database');

async function seed() {
    await initDb();

    db.serialize(() => {
        // Insert Categories
        const categories = [
            ['banking', 'https://bank-portal.com/next-step'],
            ['data', 'https://analytics-hr.com/interview'],
            ['general', 'https://company.com/onboarding']
        ];

        const catStmt = db.prepare(`INSERT OR IGNORE INTO categories (name, default_redirect_url) VALUES (?, ?)`);
        categories.forEach(c => catStmt.run(c));
        catStmt.finalize();

        // Insert Screens linked to Categories
        const screens = [
            // Banking
            [1, 'Specialty CD Form', 'cd_form.html', 1],
            [1, 'Affidavit Signature', 'affidavit.html', 0],
            // Data
            [2, 'Data Analysis Task', 'analysis.html', 1],
            [2, 'System Logic Test', 'logic.html', 0],
            // General
            [3, 'Welcome Screen', 'welcome.html', 1],
            [3, 'Personal Bio Form', 'bio.html', 0]
        ];

        const screenStmt = db.prepare(`INSERT INTO screens (category_id, screen_name, file_path, is_default) VALUES (?, ?, ?, ?)`);
        screens.forEach(s => screenStmt.run(s));
        screenStmt.finalize();

        console.log("Seeding complete.");
    });
}

seed();