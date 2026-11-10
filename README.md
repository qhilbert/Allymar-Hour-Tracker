# Allymar Hourly

Hours and invoices for Allymar Health Solutions. Node.js + PostgreSQL.

- **Owner (admin):** Chris Lowry. Adds people, sees everyone's hours, and marks invoices paid.
- **Employees:** log their hours and send invoices from their own dashboard.

## Deploy on Render
1. Put this folder in a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repository. Render reads `render.yaml`.
3. When Render asks for `OWNER_PASSWORD`, enter Chris's password.
4. Click **Apply**. When the deploy finishes, open the `.onrender.com` URL and sign in as `chris.lowry`.

The owner account is created only on the first start. After that, `OWNER_PASSWORD` is ignored, and Chris can change his password on the Account page.

**Forgot the owner password?** In Render, open the service, go to **Shell**, and run `npm run reset-owner-password`.

## Run locally
    npm install
    DATABASE_URL=postgres://user:pass@localhost:5432/hourly OWNER_PASSWORD=choose-one npm start

## Security
- Passwords are hashed with scrypt.
- Sessions use HttpOnly cookies.
- Every write needs a CSRF token.
- After 10 failed logins, sign-in is blocked for 15 minutes.
- New or reset passwords are shown once.
