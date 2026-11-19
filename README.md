# Business Reports (Tally Cloud Reporting)

## Put it online (about 10 minutes)
1. **GitHub**: create a new *public* repository and upload everything in this folder (GitHub Desktop is easiest; or "Add file -> Upload files"). The repo must be public so the connector download button works.
2. **Vercel**: vercel.com -> Add New -> Project -> pick the repo -> before pressing Deploy open *Environment Variables* and add:
   - `DATABASE_URL`: Supabase -> Connect -> **Transaction pooler** string (has your DB password)
   - `SESSION_SECRET`: any random 32+ characters
   Press Deploy.
3. **Your login** (run once on your PC, needs Node.js): `npm install`, then
   `set DATABASE_URL=<same string>` and `node scripts/create-user.mjs --tenant "Your Business" --email you@example.com --name "Your Name"`.
4. **Connector**: on GitHub open *Actions -> Build connector -> Run workflow*. After about 2 minutes the file `TallyCloudConnector.exe` exists under *Releases*.
5. **On the Tally PC**: open your website -> Sync Status -> **Connect Tally**. If the connector is not installed yet, press **Download connector**, double-click the downloaded `TallyCloudConnector.exe` (Windows may say "unknown publisher": More info -> Run anyway), then press **Connect Tally** again.
6. In TallyPrime: F1 -> Settings -> Connectivity -> Client/Server: *TallyPrime acts as* **Both**, port **9000**, with the company open.

The database tables are already created in Supabase (`supabase/migrations`, applied in order 0001 to 0003 on any new project).
Problems on the PC: run `TallyCloudConnector.exe diagnose` from the folder `%LOCALAPPDATA%\TallyCloudConnector` (the installed copy is `connector.exe`).
