# 🛠️ Database Testing Setup

This guide explains how to use your new local testing environment. You can now run the app locally using a "Test" database and sync data from "Production" whenever you need.

## 1. Create a Test Project
1. Go to [Supabase Dashboard](https://supabase.com/dashboard).
2. Create a **New Project** (e.g., "Horse Scheduler TEST").
3. Note down the **Project URL**, **Anon Key**, and **Service Role Key** (found in Project Settings -> API).

## 2. Initialize the Test Database
1. Open your **new Test Project** in the Supabase Dashboard.
2. Go to the **SQL Editor**.
3. Create a "New Query".
4. Copy the contents of your local [README_supabase.sql](file:///c:/Users/dawid/Desktop/ai%20slop/horse%20scheduler/README_supabase.sql) and paste it there.
5. Click **Run**.
   > [!IMPORTANT]
   > This creates the `app_state` table and **enables Row-Level Security (RLS)**. RLS is critical to prevent unauthorized access to your data.

## 3. Configure Local Environment
1. In your code editor, locate the folder `horse scheduler`.
2. Open `.env`. Fill in the `SUPABASE_SERVICE_ROLE_KEY` for your **Live/Production** project.
3. Find `.env.local.example`. **Copy and rename it to `.env.local`**.
4. Fill in the keys for your **New Test Project** in `.env.local`.

## 4. How it Works
| File | Usage |
| :--- | :--- |
| **`.env`** | Contains Production keys. Used by the Sync script as the **Source**. |
| **`.env.local`** | Contains Test keys. Used by Vite when you run `npm run dev` and by the Sync script as the **Target**. |

## 5. Syncing Data
Whenever you want to refresh your test database with the latest data from the live one:
1. Open your terminal in the project folder.
2. Run the following command:
   ```bash
   npm run db:sync
   ```
3. The script will read the state from your Live project and overwrite the state in your Test project.

> [!WARNING]
> The `npm run db:sync` command completely overwrites the test data. Ensure you are happy to lose any local changes in your test database before running it.

## 6. Running Locally
Simply run your normal development command:
```bash
npm run dev
```
Because `.env.local` exists, the app will connect to your **Test Database**. You can now modify things, "nuke" data, or experiment safely without affecting your live users.
