/*
 * /api/publish — função da Vercel que grava o index.html no GitHub.
 *
 * Variáveis de ambiente (Vercel → Settings → Environment Variables):
 *   GITHUB_TOKEN    token do GitHub só com acesso a ESTE repositório (Contents: Read and write)
 *   GITHUB_REPO     dono/nome do repositório, por exemplo  maria/site-da-maria
 *   ADMIN_PASSWORD  senha que o cliente digita no editor (mínimo 8 caracteres)
 *   GITHUB_BRANCH   (opcional) branch que a Vercel publica. Se ficar vazio, usa a principal
 *   GITHUB_FILE     (opcional) caminho do arquivo no repositório. Padrão: index.html
 *
 * O token e a senha ficam só aqui, no servidor. Nada disso vai para o navegador.
 */
'use strict';
const crypto = require('crypto');

const MAX_BYTES = 4.2 * 1024 * 1024; // a Vercel recusa corpos acima de ~4,5 MB
const GH = 'https://api.github.com';

/* ---------- configuração ---------- */
function readConfig() {
  const env = process.env;
  const missing = [];
  const token = (env.GITHUB_TOKEN || '').trim();
  const repo = (env.GITHUB_REPO || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  if (!token) missing.push('GITHUB_TOKEN');
  if (!repo) missing.push('GITHUB_REPO');
  if (!password) missing.push('ADMIN_PASSWORD');
  const branch = (env.GITHUB_BRANCH || '').trim();
  const file = (env.GITHUB_FILE || 'index.html').trim().replace(/^\/+/, '');
  const problems = [];
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) problems.push('GITHUB_REPO precisa ter o formato dono/nome');
  if (password && password.length < 8) problems.push('ADMIN_PASSWORD precisa ter pelo menos 8 caracteres');
  if (branch && !/^[A-Za-z0-9_./-]+$/.test(branch)) problems.push('GITHUB_BRANCH tem caracteres inválidos');
  if (!/^[A-Za-z0-9_.\-/]+$/.test(file) || file.split('/').includes('..')) problems.push('GITHUB_FILE tem caracteres inválidos');
  return { token, repo, password, branch, file, missing, problems, ok: !missing.length && !problems.length };
}

/* ---------- utilidades ---------- */
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
function gitBlobSha(text) {
  const buf = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}
function samePassword(given, real) {
  return crypto.timingSafeEqual(sha256(given), sha256(real));
}

/* limite de tentativas erradas (por instância; ajuda, mas não substitui uma senha forte) */
const fails = new Map();
const WINDOW = 10 * 60 * 1000, MAX_FAILS = 8;
function clientId(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'x';
}
function blocked(id) {
  const e = fails.get(id);
  if (!e) return false;
  if (Date.now() - e.t > WINDOW) { fails.delete(id); return false; }
  return e.n >= MAX_FAILS;
}
function noteFail(id) {
  const e = fails.get(id);
  if (!e || Date.now() - e.t > WINDOW) fails.set(id, { n: 1, t: Date.now() });
  else e.n += 1;
  if (fails.size > 500) fails.clear();
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    return req.body; // objeto já convertido pela Vercel
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES + 64 * 1024) { const e = new Error('too_large'); e.code = 'too_large'; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------- GitHub ---------- */
async function gh(cfg, method, path, body) {
  const r = await fetch(GH + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'editor-publicar',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* sem corpo */ }
  return { status: r.status, data };
}
const contentsPath = (cfg) =>
  '/repos/' + cfg.repo + '/contents/' + cfg.file.split('/').map(encodeURIComponent).join('/');

function githubFailure(r) {
  if (r.status === 401) return [502, 'github_auth', 'O GitHub recusou o token. Ele pode ter vencido ou sido apagado.'];
  if (r.status === 403) return [502, 'github_auth', 'O GitHub negou a gravação. Confira as permissões do token e se há limite de uso.'];
  if (r.status === 404) return [502, 'github_notfound', 'Repositório ou branch não encontrado. Confira GITHUB_REPO e se o token enxerga esse repositório.'];
  if (r.status === 409 || r.status === 422) return [409, 'conflict', 'O arquivo mudou no GitHub enquanto você publicava. Tente de novo.'];
  return [502, 'github_error', 'O GitHub respondeu com erro (' + r.status + '). Tente de novo em instantes.'];
}

/* ---------- validação do arquivo ---------- */
function checkHtml(html) {
  if (typeof html !== 'string' || !html) return 'Nenhum arquivo foi enviado.';
  if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) return 'too_large';
  const head = html.slice(0, 400).trimStart().toLowerCase();
  if (!head.startsWith('<!doctype html')) return 'O arquivo não parece uma página HTML.';
  if (!/<\/html>\s*$/i.test(html)) return 'O arquivo está incompleto (falta o final da página).';
  if (html.indexOf('id="ps-data"') < 0) return 'O arquivo não foi gerado pelo editor.';
  return null;
}

/* ---------- função principal ---------- */
module.exports = async function handler(req, res) {
  const cfg = readConfig();

  // Mesma origem apenas.
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* ignora */ }
    if (host !== req.headers.host) return send(res, 403, { ok: false, code: 'origin', message: 'Origem não permitida.' });
  }

  // GET: o editor pergunta se a publicação está instalada neste site. Não chama o GitHub.
  if (req.method === 'GET') {
    return send(res, 200, { ps: 'publish', v: 1, configured: cfg.ok, maxBytes: MAX_BYTES });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, code: 'method', message: 'Método não permitido.' });
  }

  if (!cfg.ok) {
    const parts = [];
    if (cfg.missing.length) parts.push('Faltam variáveis na Vercel: ' + cfg.missing.join(', ') + '.');
    parts.push(...cfg.problems.map((p) => p + '.'));
    return send(res, 503, { ok: false, code: 'not_configured', message: parts.join(' ') });
  }

  const id = clientId(req);
  if (blocked(id)) return send(res, 429, { ok: false, code: 'rate_limited', message: 'Muitas tentativas erradas. Aguarde alguns minutos.' });

  const auth = String(req.headers.authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!given || !samePassword(given, cfg.password)) {
    noteFail(id);
    await sleep(600);
    return send(res, 401, { ok: false, code: 'bad_password', message: 'Senha incorreta.' });
  }

  let body;
  try {
    body = await readBody(req);
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (e) {
    if (e && e.code === 'too_large') return send(res, 413, { ok: false, code: 'too_large', message: 'O arquivo passa do limite de 4 MB.' });
    return send(res, 400, { ok: false, code: 'bad_request', message: 'Pedido inválido.' });
  }
  if (!body || typeof body !== 'object') return send(res, 400, { ok: false, code: 'bad_request', message: 'Pedido inválido.' });

  const bad = checkHtml(body.html);
  if (bad === 'too_large') return send(res, 413, { ok: false, code: 'too_large', message: 'O arquivo passa do limite de 4 MB. Use imagens menores ou envie vídeos como arquivos separados.' });
  if (bad) return send(res, 422, { ok: false, code: 'invalid_html', message: bad });

  try {
    const q = cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '';
    const cur = await gh(cfg, 'GET', contentsPath(cfg) + q);
    let sha;
    if (cur.status === 200 && cur.data && !Array.isArray(cur.data)) {
      sha = cur.data.sha;
      // Se o arquivo no GitHub já é exatamente este, não há o que perder nem o que enviar
      // (acontece, por exemplo, quando a resposta de uma publicação anterior se perdeu).
      if (gitBlobSha(body.html) === sha) return send(res, 200, { ok: true, unchanged: true, sha });
      if (typeof body.baseSha === 'string' && body.baseSha && body.baseSha !== sha && body.force !== true) {
        return send(res, 409, { ok: false, code: 'conflict', message: 'O site foi alterado fora do editor depois que você abriu.', currentSha: sha });
      }
    } else if (cur.status !== 404) {
      const [st, code, message] = githubFailure(cur);
      return send(res, st, { ok: false, code, message });
    }

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const put = await gh(cfg, 'PUT', contentsPath(cfg), {
      message: 'Atualização pelo editor (' + stamp + ' UTC)',
      content: Buffer.from(body.html, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
      ...(cfg.branch ? { branch: cfg.branch } : {}),
    });
    if (put.status !== 200 && put.status !== 201) {
      const [st, code, message] = githubFailure(put);
      return send(res, st, { ok: false, code, message });
    }
    return send(res, 200, {
      ok: true,
      unchanged: false,
      sha: put.data && put.data.content && put.data.content.sha,
      commit: put.data && put.data.commit && put.data.commit.sha ? put.data.commit.sha.slice(0, 7) : undefined,
    });
  } catch (e) {
    return send(res, 502, { ok: false, code: 'github_error', message: 'Não consegui falar com o GitHub. Tente de novo em instantes.' });
  }
};
