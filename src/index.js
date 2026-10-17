import index from '../public/index.html';
import docs from '../public/docs.html';
import css from '../public/style.css';
import js from '../public/app.js.txt';
import { createApp } from './app.js';
export { KeyQuota } from './lib/quota.js'; // SQLite-backed Durable Object: per-key monthly quota + global daily pool ("global:budget")

const handle = createApp({ pages: { index, docs, css, js } });
export default { fetch: (req, env, ctx) => handle(req, env, ctx) };
