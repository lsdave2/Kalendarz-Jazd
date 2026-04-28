# 🐎 Horse Scheduler - Technical Guide

This project is a Vite-based web application for managing horse riding lessons, backed by **Supabase**. It features a dual-database setup (Production vs. Test) to allow for safe local development.

---

## 🛠️ Data & Database Structure

The app now stores data in **normalized Supabase tables** instead of a single JSON blob.

*   **Primary tables**: `lessons`, `packages`, `instructors`, `horses`, `groups`, `settings`
*   **Legacy fallback**: `app_state` is only used for older data migration if normalized tables are empty

Whenever you "Save" in the app, the current local state is synchronized across the normalized tables.

---

## 🔑 Environment Variables

We use `.env` files to manage database connections. These files are **ignored by Git** for security.

| File | Purpose | Active When... |
| :--- | :--- | :--- |
| **`.env`** | **Production (Live)** keys. | Default / Sync Source |
| **`.env.local`** | **Test (Local)** keys. | Running `npm run dev` |

## 🔐 Authentication (Admin Login)

Because each Supabase project has its own separate list of users, your admin account from the Live project **will not work** in the Test project automatically.

**To enable login locally:**
1. Open your **Test Project** in the Supabase Dashboard.
2. Go to **Authentication** -> **Users**.
3. Click **Add User** -> **Create new user**.
4. Enter your email/password (and uncheck "Send invite email").
5. You can now log in to the app running on `localhost`.

---

### Required Variables:
*   `VITE_SUPABASE_URL`: The Project URL from Supabase.
*   `VITE_SUPABASE_ANON_KEY`: The `anon` `public` key for client-side access.
*   `SUPABASE_SERVICE_ROLE_KEY`: The `service_role` `secret` key (needed for the sync script).

---

## 🔄 Database Synchronization

You can clone your live data to your test database whenever you want a fresh testing environment.

1.  Ensure `.env` has your **Live** keys.
2.  Ensure `.env.local` has your **Test** keys.
3.  Run the sync command:
    ```bash
    npm run db:sync
    ```
*The script copies the normalized tables from the Live project into the Test project. If the Live project only has legacy `app_state` data, the script falls back to copying that row instead.*

---

## 🚀 Deployment & Security

### GitHub Repository Secrets
Because `.env` files are not uploaded to GitHub, you must manually add your **Production keys** to your hosting provider's settings (e.g., GitHub Secrets):

1.  Go to **GitHub Repo** → **Settings** → **Secrets and variables** → **Actions**.
2.  Add:
    *   `VITE_SUPABASE_URL`
    *   `VITE_SUPABASE_ANON_KEY`

### Security Best Practices
*   **Never** hardcode keys in `src/supabase.js`. Always use `import.meta.env`.
*   **Never** put the `SUPABASE_SERVICE_ROLE_KEY` in files that the browser can see. It should only stay in your `.env` files for scripts.

---

## 📁 Key Files
*   `src/supabase.js`: Initializes the Supabase client using environment variables.
*   `scripts/sync-db.mjs`: The Node.js tool for cloning data between projects.
*   `README_supabase.sql`: The SQL required to initialize a new Supabase project for this app.
*   `package.json`: Contains project scripts like `db:sync` and `dev`.

---

## 👷 Local Development Workflow
1.  Run `npm run dev` to start the local server.
2.  The app will connect to your **Test Database** (defined in `.env.local`).
3.  Make changes, test new features, or experiment safely.
4.  If you break your test data, run `npm run db:sync` to restore it from the live version.
