const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const os = require('os');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { port: 3000 }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

let config = loadConfig();
const PORT = config.port || 3000;

let folderChanged = false;
let watcher = null;

const jobsFolder = () => config.jobsFolder || null;
const jobsJsonPath = () => path.join(__dirname, 'jobs.json');
const contractorsJsonPath = () => path.join(__dirname, 'contractors.json');

function readContractors() {
  const p = contractorsJsonPath();
  if (!fs.existsSync(p)) fs.writeFileSync(p, '{}', 'utf8');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    let migrated = false;
    for (const [name, val] of Object.entries(data)) {
      if (!Array.isArray(val.contacts)) {
        const c = {};
        if (val.phone) c.phone = val.phone;
        if (val.email) c.email = val.email;
        if (val.client_name) c.client_name = val.client_name;
        data[name] = { contacts: Object.keys(c).length > 0 ? [c] : [] };
        migrated = true;
      }
    }
    if (migrated) writeContractors(data);
    return data;
  } catch { return {}; }
}

function writeContractors(data) {
  fs.writeFileSync(contractorsJsonPath(), JSON.stringify(data, null, 2), { encoding: 'utf8' });
}

function ensureJobsJson() {
  const p = jobsJsonPath();
  if (!fs.existsSync(p)) fs.writeFileSync(p, '{}', 'utf8');
}

function readJobsData() {
  ensureJobsJson();
  const p = jobsJsonPath();
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeJobsData(data) {
  const p = jobsJsonPath();
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { encoding: 'utf8' });
}

// "TW26030 Schoenne Manitoba" -> { job_id: "TW26030", project_name: "Schoenne Manitoba" }
function parseFolderName(name) {
  const m = name.match(/^([A-Z]{2}\d{5})\s*(.*)$/);
  return m ? { job_id: m[1], project_name: m[2].trim() } : null;
}

// TW26001 -> "2026"
function yearFromJobId(job_id) {
  const y = parseInt(job_id.slice(2, 4), 10);
  return String(y >= 50 ? 1900 + y : 2000 + y);
}

function getYearFolders(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name);
}

// Returns the main .isl file in a folder (excludes backup files containing _bak_)
function findIslFile(folderPath) {
  try {
    const main = fs.readdirSync(folderPath)
      .find(f => f.toLowerCase().endsWith('.isl') && !f.toLowerCase().includes('_bak_'));
    return main ? path.join(folderPath, main) : null;
  } catch { return null; }
}

function scanJobs() {
  const root = jobsFolder();
  if (!root) return [];
  const data = readJobsData();
  const jobs = [];

  for (const year of getYearFolders(root)) {
    const yearPath = path.join(root, year);
    for (const entry of fs.readdirSync(yearPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const parsed = parseFolderName(entry.name);
      if (!parsed) continue;
      const meta = data[parsed.job_id] || {};
      const jobPath = path.join(yearPath, entry.name);
      const hasIsl = !!findIslFile(jobPath);
      jobs.push({ ...meta, job_id: parsed.job_id, project_name: parsed.project_name, has_isl: hasIsl });
    }
  }

  jobs.sort((a, b) => b.job_id.localeCompare(a.job_id));
  return jobs;
}

function findJobFolder(job_id) {
  const root = jobsFolder();
  if (!root) return null;
  for (const year of getYearFolders(root)) {
    const yearPath = path.join(root, year);
    const match = fs.readdirSync(yearPath, { withFileTypes: true })
      .find(e => e.isDirectory() && (e.name === job_id || e.name.startsWith(job_id + ' ')));
    if (match) return path.join(yearPath, match.name);
  }
  return null;
}

function startWatcher() {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  const root = jobsFolder();
  if (!root || !fs.existsSync(root)) return;
  try {
    watcher = fs.watch(root, { recursive: true }, () => { folderChanged = true; });
    console.log(`Watching: ${root}`);
  } catch (e) {
    console.warn('Watch failed:', e.message);
  }
}

// Windows folder picker via PowerShell
// Runs in -STA mode (required for WinForms) and uses a TopMost owner form
// so the dialog appears above the browser window.
function pickFolder() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-2000, -2000)
$owner.Show()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Select your Jobs root folder'
$dlg.ShowNewFolderButton = $true
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dlg.SelectedPath
}
$owner.Dispose()
`;
  const tmp = path.join(os.tmpdir(), 'jt_pick.ps1');
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-STA', '-File', tmp], {
      encoding: 'utf8', timeout: 60000,
    }).trim() || null;
  } catch { return null; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (p.startsWith('/api/')) {

    // GET /api/config
    if (p === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, { jobsFolder: config.jobsFolder || null, configured: !!config.jobsFolder });
      return;
    }

    // POST /api/setup/browse — open OS folder picker
    if (p === '/api/setup/browse' && req.method === 'POST') {
      const picked = pickFolder();
      sendJson(res, 200, { path: picked });
      return;
    }

    // POST /api/setup/save — persist chosen folder
    if (p === '/api/setup/save' && req.method === 'POST') {
      const body = await parseBody(req);
      const folder = (body.jobsFolder || '').trim();
      if (!folder) { sendJson(res, 400, { error: 'No folder provided' }); return; }
      try { fs.mkdirSync(folder, { recursive: true }); } catch {
        sendJson(res, 400, { error: 'Cannot create folder: ' + folder }); return;
      }
      config.jobsFolder = folder;
      saveConfig(config);
      ensureJobsJson();
      startWatcher();
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/contractors — list all contractor profiles
    if (p === '/api/contractors' && req.method === 'GET') {
      sendJson(res, 200, readContractors());
      return;
    }

    // POST /api/contractors/:name/contacts — add or update a single contact
    if (p.match(/^\/api\/contractors\/[^/]+\/contacts$/) && req.method === 'POST') {
      const name = decodeURIComponent(p.split('/')[3]);
      const body = await parseBody(req);
      const data = readContractors();
      if (!data[name]) data[name] = { contacts: [] };
      const contacts = data[name].contacts;
      const contact = {};
      if (body.client_name) contact.client_name = body.client_name;
      if (body.phone) contact.phone = body.phone;
      if (body.email) contact.email = body.email;
      if (Object.keys(contact).length === 0) { sendJson(res, 400, { error: 'Empty contact' }); return; }
      const idx = body.client_name ? contacts.findIndex(c => c.client_name === body.client_name) : -1;
      if (idx >= 0) { contacts[idx] = { ...contacts[idx], ...contact }; }
      else { contacts.push(contact); }
      writeContractors(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // PUT /api/contractors/:name — replace full contacts array
    if (p.match(/^\/api\/contractors\/[^/]+$/) && req.method === 'PUT') {
      const name = decodeURIComponent(p.split('/')[3]);
      const body = await parseBody(req);
      const data = readContractors();
      if (!data[name]) data[name] = { contacts: [] };
      if (Array.isArray(body.contacts)) data[name].contacts = body.contacts;
      writeContractors(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // DELETE /api/contractors/:name — delete a contractor profile
    if (p.match(/^\/api\/contractors\/[^/]+$/) && req.method === 'DELETE') {
      const name = decodeURIComponent(p.split('/')[3]);
      const data = readContractors();
      delete data[name];
      writeContractors(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/contractors/import — bootstrap contractor profiles from existing job data
    if (p === '/api/contractors/import' && req.method === 'POST') {
      const jobs = readJobsData();
      const contractors = readContractors();
      let added = 0;
      for (const job of Object.values(jobs)) {
        const name = (job.contractor_name || '').trim();
        if (!name) continue;
        if (!contractors[name]) contractors[name] = { contacts: [] };
        const contact = {};
        if (job.phone) contact.phone = job.phone;
        if (job.email) contact.email = job.email;
        if (job.client_name) contact.client_name = job.client_name;
        if (Object.keys(contact).length === 0) continue;
        const isDup = contractors[name].contacts.some(c =>
          (contact.phone && c.phone === contact.phone) ||
          (contact.email && c.email === contact.email)
        );
        if (!isDup) { contractors[name].contacts.push(contact); added++; }
      }
      writeContractors(contractors);
      sendJson(res, 200, { ok: true, added, total: Object.keys(contractors).length });
      return;
    }

    // POST /api/jobs/:id/open — open job folder in Explorer on top
    if (p.match(/^\/api\/jobs\/[^/]+\/open$/) && req.method === 'POST') {
      const job_id = decodeURIComponent(p.split('/')[3]);
      const folder = findJobFolder(job_id);
      if (!folder) { sendJson(res, 404, { error: 'Folder not found for ' + job_id }); return; }
      const folderName = path.basename(folder).replace(/'/g, "''");
      const safePath  = folder.replace(/'/g, "''");
      const cmd = `Start-Process explorer.exe -ArgumentList '${safePath}'; Start-Sleep -Milliseconds 700; (New-Object -ComObject WScript.Shell).AppActivate('${folderName}')`;
      execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', cmd]);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/jobs/:id/open-isl — open main .isl file with default app
    if (p.match(/^\/api\/jobs\/[^/]+\/open-isl$/) && req.method === 'POST') {
      const job_id = decodeURIComponent(p.split('/')[3]);
      const folder = findJobFolder(job_id);
      if (!folder) { sendJson(res, 404, { error: 'Folder not found for ' + job_id }); return; }
      const isl = findIslFile(folder);
      if (!isl) { sendJson(res, 404, { error: 'No ISL file found' }); return; }
      const safeIsl = isl.replace(/'/g, "''");
      execFile('powershell.exe', ['-WindowStyle', 'Hidden', '-Command',
        `Start-Process '${safeIsl}'; Start-Sleep -Milliseconds 800; (New-Object -ComObject WScript.Shell).AppActivate('IronCAD')`
      ]);
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/jobs
    if (p === '/api/jobs' && req.method === 'GET') {
      sendJson(res, 200, scanJobs());
      return;
    }

    // GET /api/changed
    if (p === '/api/changed' && req.method === 'GET') {
      const changed = folderChanged;
      folderChanged = false;
      sendJson(res, 200, { changed });
      return;
    }

    // POST /api/jobs/:id/log — append activity log entry
    if (p.match(/^\/api\/jobs\/[^/]+\/log$/) && req.method === 'POST') {
      const jobId = decodeURIComponent(p.split('/')[3]);
      const body = await parseBody(req);
      const text = (body.text || '').trim();
      if (!text) { sendJson(res, 400, { error: 'Empty log entry' }); return; }
      const data = readJobsData();
      if (!data[jobId]) data[jobId] = {};
      if (!Array.isArray(data[jobId].activity_log)) data[jobId].activity_log = [];
      data[jobId].activity_log.push({ ts: new Date().toISOString(), text });
      writeJobsData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // DELETE /api/jobs/:id/log/:index — delete activity log entry
    if (p.match(/^\/api\/jobs\/[^/]+\/log\/\d+$/) && req.method === 'DELETE') {
      const parts = p.split('/');
      const jobId = decodeURIComponent(parts[3]);
      const index = parseInt(parts[5], 10);
      const data = readJobsData();
      if (!data[jobId] || !Array.isArray(data[jobId].activity_log)) {
        sendJson(res, 404, { error: 'No log found' }); return;
      }
      if (index < 0 || index >= data[jobId].activity_log.length) {
        sendJson(res, 404, { error: 'Invalid log index' }); return;
      }
      data[jobId].activity_log.splice(index, 1);
      writeJobsData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/export — CSV export of all jobs
    if (p === '/api/export' && req.method === 'GET') {
      const jobs = scanJobs();
      const cols = ['job_id','project_name','status','quote_number','contractor_name','address','client_name','phone','email','quote_value','due_date','quote_sent_date','revision','notes'];
      const headers = ['Job #','Project','Status','Quote #','Contractor','Address','Client','Phone','Email','Quote Value','Due Date','Quote Sent','Revision','Notes'];
      const csvEsc = v => { const s = v == null ? '' : String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g,'""') + '"' : s; };
      const rows = [headers.join(',')];
      for (const j of jobs) rows.push(cols.map(c => csvEsc(j[c])).join(','));
      const csv = rows.join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="JobTracker_Export.csv"' });
      res.end(csv);
      return;
    }

    // PUT /api/jobs/:id
    if (p.startsWith('/api/jobs/') && req.method === 'PUT') {
      const jobId = decodeURIComponent(p.replace('/api/jobs/', ''));
      const body = await parseBody(req);
      const data = readJobsData();
      data[jobId] = { ...(data[jobId] || {}), ...body };
      writeJobsData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/jobs — create new job folder inside year subfolder
    if (p === '/api/jobs' && req.method === 'POST') {
      const root = jobsFolder();
      if (!root) { sendJson(res, 503, { error: 'Jobs folder not configured' }); return; }
      const body = await parseBody(req);
      const { job_id, project_name, due_date } = body;
      if (!job_id || !job_id.match(/^[A-Z]{2}\d{5}$/)) {
        sendJson(res, 400, { error: 'Invalid job ID format (e.g. TW26030)' }); return;
      }

      // Check duplicate job ID across all year folders
      for (const year of getYearFolders(root)) {
        const yp = path.join(root, year);
        const dup = fs.readdirSync(yp, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .find(e => e.name === job_id || e.name.startsWith(job_id + ' '));
        if (dup) {
          sendJson(res, 409, { error: `${job_id} already exists (${year}/${dup.name})` }); return;
        }
      }

      const year = yearFromJobId(job_id);
      const folderName = project_name ? `${job_id} ${project_name}` : job_id;
      const jobPath = path.join(root, year, folderName);
      fs.mkdirSync(jobPath, { recursive: true });

      const data = readJobsData();
      if (!data[job_id]) data[job_id] = {};
      data[job_id].created_date = new Date().toISOString().slice(0, 10);
      if (due_date) data[job_id].due_date = due_date;
      writeJobsData(data);
      folderChanged = true;
      sendJson(res, 201, { ok: true, job_id, project_name });
      return;
    }

    // POST /api/shutdown
    if (p === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  // Serve index.html
  fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

startWatcher();

server.listen(PORT, () => {
  console.log(`JobTracker3000 running at http://localhost:${PORT}`);
  console.log(config.jobsFolder ? `Jobs folder: ${config.jobsFolder}` : 'No folder configured — open app to set up.');
  console.log('Press Ctrl+C to stop.');
});
