'use strict';
// Usage (from the host's shell): npm run reset-owner-password
// Sets a new random password for the owner account and prints it once.
const crypto = require('crypto');
const { pool, hashPassword, init } = require('./server.js');

(async () => {
  await init();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 12; i++) { pw += A[crypto.randomInt(A.length)]; if (i === 3 || i === 7) pw += '-'; }
  const r = await pool.query("UPDATE users SET password_hash = $1 WHERE role = 'owner' RETURNING username", [hashPassword(pw)]);
  await pool.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'owner')");
  console.log(`Owner username: ${r.rows[0].username}\nNew password:   ${pw}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
