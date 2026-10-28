'use strict';

const $ = id => document.getElementById(id);
let csrf = '', issues = [], entries = [], selected = new Set(), boardIds = [], validated = false;
let jiraConfigured = false, weeklyRequest = 0;
// Weekly worklogs are kept per week so switching tabs doesn't re-read Jira; cleared on any write or settings change.
const weeklyCache = new Map(), weeklyCacheTtl = 5 * 60 * 1000;
let syncHistory = [], historyLoaded = false;
let alertRequest = 0, alertLoadedKey = '', alertBusy = false;
let calendarRules = [], calendarFallback = 'KNP-50';

// Worklogs are only allowed on Task and Sub-task issues (the server enforces the same rule).
const loggableTypes = new Set(['task', 'sub-task', 'subtask']);
const isLoggable = issue => loggableTypes.has(String(issue.type || '').trim().toLowerCase());

function fillIssueFilters() {
  const statuses = [...new Set(issues.map(issue => issue.status))].filter(Boolean).sort();
  const types = [...new Set(issues.map(issue => issue.type))].filter(Boolean).sort();
  $('status').replaceChildren(new Option('ทั้งหมด', ''), ...statuses.map(value => new Option(value, value)));
  $('issueType').replaceChildren(new Option('ทั้งหมด', ''), ...types.map(value => new Option(isLoggable({ type: value }) ? value : `${value} (ลงเวลาไม่ได้)`, value)));
}

function calendarRuleIssues() {
  return [...new Set([...calendarRules.map(rule => rule.issue), calendarFallback])];
}

function parseBoardIds(value) {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw Error('กรอก Board ID อย่างน้อย 1 บอร์ด');
  const ids = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part) || Number(part) < 1 || Number(part) >= 1000000000) {
      throw Error('Board IDs ต้องเป็นตัวเลขบวก คั่นด้วยจุลภาค');
    }
    const id = String(Number(part));
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > 10) throw Error('เลือกได้ไม่เกิน 10 บอร์ดต่อครั้ง');
  return ids;
}

function showView() {
  const settingsOpen = location.hash === '#settings';
  const weeklyOpen = location.hash === '#weekly';
  const calendarOpen = location.hash === '#calendar';
  const historyOpen = location.hash === '#history';
  $('workspaceView').classList.toggle('hide', settingsOpen || weeklyOpen || calendarOpen || historyOpen);
  $('weeklyView').classList.toggle('hide', !weeklyOpen);
  $('calendarView').classList.toggle('hide', !calendarOpen);
  $('historyView').classList.toggle('hide', !historyOpen);
  $('settingsView').classList.toggle('hide', !settingsOpen);
  $('settingsNav').setAttribute('aria-current', settingsOpen ? 'page' : 'false');
  $('weeklyNav').setAttribute('aria-current', weeklyOpen ? 'page' : 'false');
  $('calendarNav').setAttribute('aria-current', calendarOpen ? 'page' : 'false');
  $('historyNav').setAttribute('aria-current', historyOpen ? 'page' : 'false');
  $('worklogsNav').setAttribute('aria-current', settingsOpen || weeklyOpen || calendarOpen || historyOpen ? 'false' : 'page');
  if (weeklyOpen && jiraConfigured) {
    loadWeekly();
    const alertKey = `${$('alertYear').value}:${$('alertRange').value}`;
    if (!alertBusy && alertLoadedKey !== alertKey) loadAlerts();
  }
  if (calendarOpen) calendarViewOpened();
  if (historyOpen && !historyLoaded) refreshHistory();
}

function renderHistory() {
  const query = $('historyFilter').value.trim().toUpperCase();
  const status = $('historyStatus').value;
  const records = syncHistory.filter(item => item.issue.includes(query) && (!status || item.status === status));
  const rows = records.map(item => {
    const row = document.createElement('tr');
    cell(row, item.issue, 'issue-key');
    cell(row, item.date);
    cell(row, item.seconds ? hoursLabel(item.seconds) : '—');
    cell(row, { calendar: 'Mac Calendar', manual: 'ลงเวลา', jira: 'พบใน Jira' }[item.source] || item.source);
    const statusCell = cell(row, '');
    const badge = document.createElement('span');
    badge.className = `sync-pill ${item.status}`;
    badge.textContent = { uncertain: 'ต้องตรวจสอบ', retry_ready: 'ไม่พบรายการตรงกัน', synced: 'บันทึกแล้ว' }[item.status] || item.status;
    statusCell.append(badge);
    cell(row, item.id || '—');
    cell(row, item.savedAt ? new Date(item.savedAt).toLocaleString('th-TH') : '—');
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const empty = cell(row, syncHistory.length ? 'ไม่พบรายการที่ตรงกับตัวกรอง' : 'ยังไม่มีประวัติการส่งจากแอปนี้');
    empty.colSpan = 7;
    empty.className = 'empty-state';
    rows.push(row);
  }
  $('historyRows').replaceChildren(...rows);
  $('historyCount').textContent = `${records.length} / ${syncHistory.length} รายการ`;
}

async function refreshHistory() {
  try {
    const data = await call('/api/history');
    syncHistory = data.records || [];
    historyLoaded = true;
    $('historyMessage').textContent = `เก็บบนเครื่องนี้ ${syncHistory.length} รายการ · ตรวจ Jira ก่อนลองส่งรายการที่สถานะไม่แน่ชัด`;
    renderHistory();
    if (issues.length) renderIssues();
    if (entries.length) renderEntries();
    if (calendarProposals.length) renderCalendarRows();
    return true;
  } catch (error) {
    $('historyMessage').textContent = error.message;
    return false;
  }
}

function settingsMsg(text, tone = 'neutral') {
  $('settingsMessage').textContent = text;
  $('settingsMessage').className = `settings-message ${tone}`;
}

function mappingDraft() {
  const rules = [...$('mappingRules').querySelectorAll('.mapping-rule')].map(row => ({
    name: row.querySelector('[data-field="name"]').value,
    terms: row.querySelector('[data-field="terms"]').value.split(',').map(term => term.trim()).filter(Boolean),
    issue: row.querySelector('[data-field="issue"]').value,
    isLeave: row.querySelector('[data-field="isLeave"]').checked
  }));
  return { rules, fallback: $('mappingFallback').value };
}

function mappingMsg(text, tone = 'neutral') {
  $('mappingMessage').textContent = text;
  $('mappingMessage').className = `settings-message ${tone}`;
}

function mappingChanged() {
  $('mappingPreviewResult').textContent = 'ค่าเปลี่ยนแล้ว · ทดสอบใหม่ได้';
  $('mappingPreviewResult').className = '';
  mappingMsg('ยังไม่ได้บันทึก · กดบันทึกเพื่อตรวจสิทธิ์ใน Jira');
}

function renderMappingRules(rules, summaries = new Map()) {
  const rows = rules.map((rule, index) => {
    const row = document.createElement('div');
    row.className = 'mapping-rule';
    row.innerHTML = `<div class="mapping-rule-head"><strong>กฎ ${index + 1}</strong><div class="mapping-rule-actions"><button type="button" class="ghost mapping-up" aria-label="เลื่อนกฎขึ้น">↑</button><button type="button" class="ghost mapping-down" aria-label="เลื่อนกฎลง">↓</button><button type="button" class="ghost mapping-remove">ลบ</button></div></div><div class="mapping-rule-fields"><label class="field"><span>ชื่อกฎ</span><input data-field="name" type="text" required maxlength="80" placeholder="เช่น Weekly Team Sync"></label><label class="field"><span>คำค้นในชื่อประชุม (คั่นด้วยจุลภาค)</span><input data-field="terms" type="text" required placeholder="เช่น Weekly Sync, Team Sync"></label><label class="field"><span>Jira Issue Key หรือ URL</span><input data-field="issue" type="text" required placeholder="KNP-50"></label></div><label class="mapping-leave"><input data-field="isLeave" type="checkbox"> ถือเป็นวันลา (เหตุการณ์ทั้งวัน = 8 ชั่วโมง)</label><small class="mapping-status">ยังไม่ตรวจสอบใน Jira</small>`;
    row.querySelector('[data-field="name"]').value = rule.name || '';
    row.querySelector('[data-field="terms"]').value = (rule.terms || []).join(', ');
    row.querySelector('[data-field="issue"]').value = rule.issue || '';
    row.querySelector('[data-field="isLeave"]').checked = Boolean(rule.isLeave);
    const summary = summaries.get(rule.issue);
    if (summary !== undefined) {
      row.querySelector('.mapping-status').textContent = `✓ ${rule.issue}${summary ? ` · ${summary}` : ''}`;
      row.querySelector('.mapping-status').classList.add('good');
    }
    row.querySelector('.mapping-up').disabled = index === 0;
    row.querySelector('.mapping-down').disabled = index === rules.length - 1;
    for (const input of row.querySelectorAll('input')) input.addEventListener('input', () => {
      row.querySelector('.mapping-status').textContent = 'ยังไม่ตรวจสอบการเปลี่ยนแปลง';
      row.querySelector('.mapping-status').className = 'mapping-status';
      mappingChanged();
    });
    row.querySelector('.mapping-remove').onclick = () => {
      const next = mappingDraft().rules;
      next.splice(index, 1);
      renderMappingRules(next);
      mappingChanged();
    };
    for (const [selector, offset] of [['.mapping-up', -1], ['.mapping-down', 1]]) {
      row.querySelector(selector).onclick = () => {
        const next = mappingDraft().rules;
        [next[index], next[index + offset]] = [next[index + offset], next[index]];
        renderMappingRules(next);
        mappingChanged();
      };
    }
    return row;
  });
  $('mappingRules').replaceChildren(...rows);
  $('mappingAdd').disabled = rules.length >= 30;
}

function applySettings(data) {
  jiraConfigured = data.configured;
  weeklyCache.clear();
  calendarRules = data.calendarRules || [];
  calendarFallback = data.calendarFallback || 'KNP-50';
  renderMappingRules(calendarRules);
  $('mappingFallback').value = calendarFallback;
  $('mappingFallbackStatus').textContent = 'ยังไม่ตรวจสอบใน Jira';
  $('mappingFallbackStatus').className = 'mapping-status';
  $('saveMapping').disabled = !data.configured;
  $('mappingPreview').disabled = !data.configured;
  $('mappingPreviewResult').textContent = 'ยังไม่ได้ทดสอบ';
  $('mappingPreviewResult').className = '';
  mappingMsg(data.configured ? 'แก้การ์ดแล้วกดบันทึกเพื่อตรวจสิทธิ์ใน Jira' : 'บันทึกการเชื่อมต่อ Jira ก่อน แล้วจึงตั้งค่าการ์ดประชุม');
  $('settingUrl').value = data.baseUrl || '';
  $('settingEmail').value = data.email || '';
  $('settingTimezone').value = data.timezone || 'Asia/Bangkok';
  $('settingBoardIds').value = (data.boardIds || []).join(', ');
  $('boardIds').value = (data.boardIds || []).join(', ');
  $('settingToken').value = '';
  $('tokenStatus').textContent = data.hasToken
    ? 'มี token ใช้งานอยู่ · เว้นว่างเพื่อใช้ค่าเดิม'
    : 'ยังไม่มี token ที่บันทึกไว้';
  $('configBadge').textContent = data.configured ? 'พร้อมเชื่อมต่อ' : 'ยังไม่พร้อม';
  $('configBadge').classList.toggle('ready', data.configured);
  $('testJira').disabled = !data.configured;
  $('defaultDate').value = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  if (!$('weekDate').value) $('weekDate').value = $('defaultDate').value;
  if (!$('calendarDate').value) $('calendarDate').value = $('defaultDate').value;
  if (!$('alertYear').value) $('alertYear').value = $('defaultDate').value.slice(0, 4);
  $('alertYear').max = $('defaultDate').value.slice(0, 4);
}

function msg(text, tone = 'neutral') {
  $('message').textContent = text;
  $('statusPanel').classList.toggle('good-state', tone === 'good');
  $('statusPanel').classList.toggle('bad-state', tone === 'bad');
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function cell(tr, value, className = '') {
  const td = document.createElement('td');
  td.textContent = value ?? '';
  if (className) td.className = className;
  tr.append(td);
  return td;
}

function control(type, value, change, attrs = {}) {
  const el = document.createElement('input');
  el.type = type;
  el.value = value;
  el.className = 'entry-input';
  for (const [key, attrValue] of Object.entries(attrs)) {
    if (key === 'class') el.className += ` ${attrValue}`;
    else el.setAttribute(key, attrValue);
  }
  el.addEventListener('input', () => {
    change(el.value);
    invalidate();
    updateMetrics();
  });
  return el;
}

function updateMetrics() {
  const totalHours = entries.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  $('metricIssues').textContent = issues.length || '—';
  $('metricSelected').textContent = selected.size;
  $('metricEntries').textContent = entries.length;
  $('metricHours').textContent = totalHours.toFixed(2);
  $('add').disabled = selected.size === 0;
  $('totals').textContent = entries.length
    ? `${entries.length} Worklogs • ${totalHours.toFixed(2)} ชั่วโมงรวม`
    : 'ยังไม่มี Worklog รอส่ง';
  $('stepIssues').classList.toggle('active', issues.length > 0);
  $('stepSubmit').classList.toggle('active', entries.length > 0);
}

function invalidate() {
  validated = false;
  $('submit').disabled = true;
  $('submit').textContent = $('submit').dataset.label || 'บันทึกลง Jira';
}

async function call(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const json = await response.json();
  if (!response.ok) throw Error(json.error || 'Request failed');
  return json;
}

function hoursLabel(seconds) {
  return `${(seconds / 3600).toLocaleString('th-TH', { maximumFractionDigits: 2 })} ชม.`;
}

function shiftWeek(days) {
  const current = new Date(`${$('weekDate').value}T12:00:00Z`);
  current.setUTCDate(current.getUTCDate() + days);
  $('weekDate').value = current.toISOString().slice(0, 10);
  loadWeekly();
}

function renderWeekly(data) {
  $('weekDate').value = data.weekStart;
  $('weekRange').textContent = `${data.weekStart} – ${data.weekEnd} · Timezone ${data.timezone}`;
  $('weekLogged').textContent = hoursLabel(data.totalSeconds);
  $('weekTarget').textContent = hoursLabel(data.targetSeconds);
  $('weekComplete').textContent = `${data.days.filter(day => day.status === 'complete').length} / ${data.days.filter(day => day.targetSeconds > 0).length}`;
  const labels = { complete: 'ครบ 8 ชั่วโมง', short: 'ยังขาดเวลา', today: 'วันนี้ · ยังไม่ครบ', upcoming: 'ยังไม่ถึงวัน', holiday: 'วันหยุด BOT' };
  const weekdayNames = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์'];
  const cards = data.days.map((day, index) => {
    const card = document.createElement('article');
    card.className = `weekly-day ${day.status}`;
    const heading = document.createElement('div');
    heading.className = 'weekly-day-head';
    const name = document.createElement('div');
    name.className = 'weekly-day-name';
    const weekday = document.createElement('strong');
    weekday.textContent = `วัน${weekdayNames[index]}`;
    const date = document.createElement('span');
    date.textContent = day.date;
    name.append(weekday, date);
    const badge = document.createElement('span');
    badge.className = 'weekly-status';
    badge.textContent = labels[day.status];
    heading.append(name, badge);
    const amount = document.createElement('div');
    amount.className = 'weekly-amount';
    const logged = document.createElement('strong');
    logged.textContent = hoursLabel(day.seconds);
    const target = document.createElement('span');
    target.textContent = day.targetSeconds ? '/ 8 ชม.' : '/ วันหยุด';
    amount.append(logged, target);
    const track = document.createElement('div');
    track.className = 'weekly-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `วัน${weekdayNames[index]} บันทึก ${hoursLabel(day.seconds)} จากเป้า ${hoursLabel(day.targetSeconds)}`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '8');
    track.setAttribute('aria-valuenow', String(Math.min(day.seconds / 3600, 8)));
    const fill = document.createElement('span');
    fill.style.width = `${day.targetSeconds ? Math.min(100, day.seconds / day.targetSeconds * 100) : 0}%`;
    track.append(fill);
    track.classList.toggle('hide', !day.targetSeconds);
    const remaining = document.createElement('p');
    remaining.className = 'weekly-remaining';
    remaining.textContent = day.holidayName ? day.holidayName : day.seconds >= 28800 ? 'ถึงเป้าหมายแล้ว' : `ขาดอีก ${hoursLabel(28800 - day.seconds)} จากเป้า`;
    const entries = document.createElement('div');
    entries.className = 'weekly-entries';
    if (!day.entries.length) {
      const empty = document.createElement('p');
      empty.className = 'weekly-empty';
      empty.textContent = 'ยังไม่มี worklog ในวันนี้';
      entries.append(empty);
    } else {
      for (const entry of day.entries) {
        const row = document.createElement('div');
        row.className = 'weekly-entry';
        const key = document.createElement('span');
        key.className = 'issue-key';
        key.textContent = entry.issue;
        const summary = document.createElement('span');
        summary.className = 'weekly-entry-summary';
        summary.textContent = entry.summary;
        const duration = document.createElement('strong');
        duration.textContent = hoursLabel(entry.seconds);
        row.append(key, summary, duration);
        entries.append(row);
      }
    }
    card.append(heading, amount, track, remaining, entries);
    return card;
  });
  $('weeklyDays').replaceChildren(...cards);
  $('weekendNote').textContent = data.weekendSeconds ? `บันทึกวันเสาร์–อาทิตย์ ${hoursLabel(data.weekendSeconds)} (ไม่นับในเป้าวันทำงาน)` : '';
  $('weekendNote').classList.toggle('hide', !data.weekendSeconds);
  $('weeklyResults').classList.remove('hide');
}

function weeklyStatus(data, cachedAt) {
  const cacheNote = cachedAt ? ` · จากแคช ${new Date(cachedAt).toLocaleTimeString('th-TH')} (กดโหลดใหม่เพื่ออัปเดต)` : '';
  $('weeklyMessage').textContent = `โหลด worklog จริงของคุณแล้ว · ${data.days.reduce((sum, day) => sum + day.entries.length, 0)} รายการในวันทำงาน${data.holidayWarning ? ` · ยังซิงก์ BOT ไม่ได้: ${data.holidayWarning} (เป้าชั่วโมงชั่วคราว)` : data.botYears.some(item => item.stale) ? ' · ใช้วันหยุด BOT จากแคชเก่า' : ''}${cacheNote}`;
  $('weeklyMessage').className = `weekly-message ${data.holidayWarning ? 'bad' : 'good'}`;
}

async function loadWeekly(force = false) {
  if (!jiraConfigured) {
    $('weeklyMessage').textContent = 'ตั้งค่า Jira ก่อนดู worklog รายสัปดาห์';
    return;
  }
  const selectedDate = $('weekDate').value;
  if (!selectedDate) return;
  const cached = weeklyCache.get(selectedDate);
  if (!force && cached && Date.now() - cached.time < weeklyCacheTtl) {
    ++weeklyRequest;
    renderWeekly(cached.data);
    weeklyStatus(cached.data, cached.time);
    return;
  }
  const requestId = ++weeklyRequest;
  const button = $('weekReload');
  setBusy(button, true, 'กำลังโหลด…');
  $('weeklyMessage').textContent = 'กำลังอ่าน worklog จาก Jira…';
  $('weeklyMessage').className = 'weekly-message';
  try {
    const data = await call('/api/worklogs/week?date=' + encodeURIComponent(selectedDate));
    if (requestId !== weeklyRequest) return;
    renderWeekly(data);
    weeklyStatus(data);
    const entry = { data, time: Date.now() };
    weeklyCache.set(selectedDate, entry);
    if (data.weekStart) weeklyCache.set(data.weekStart, entry);
  } catch (error) {
    if (requestId !== weeklyRequest) return;
    $('weeklyResults').classList.add('hide');
    $('weeklyMessage').textContent = error.message;
    $('weeklyMessage').className = 'weekly-message bad';
  } finally {
    if (requestId === weeklyRequest) setBusy(button, false, '');
  }
}

$('weekPrev').onclick = () => shiftWeek(-7);
$('weekNext').onclick = () => shiftWeek(7);
$('weekReload').onclick = () => loadWeekly(true);
$('weekDate').onchange = () => loadWeekly();

function renderAlerts(data) {
  $('alertCount').textContent = `${data.weeks.length} สัปดาห์ · ${data.missingDays} วัน`;
  const source = data.botYears.map(item => `${item.year} ${item.stale ? 'แคชเดิม' : 'ซิงก์แล้ว'} ${new Date(item.syncedAt * 1000).toLocaleString('th-TH')}`).join(' · ');
  $('alertMessage').textContent = `ช่วง ${data.rangeStart} – ${data.rangeEnd} · ตรวจ ${data.workdaysChecked} วันทำงาน · วันหยุด BOT ${data.holidayCount} วัน · ${source}${data.botYears.some(item => item.stale) ? ' · BOT ติดต่อไม่ได้ ใช้ข้อมูลแคช' : ''}`;
  const cards = data.weeks.map(week => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'weekly-alert-card';
    const heading = document.createElement('strong');
    heading.textContent = `${week.weekStart} – ${week.weekEnd}`;
    const amount = document.createElement('span');
    amount.textContent = `${week.days.length} วัน · ขาด ${hoursLabel(week.missingSeconds)}`;
    const details = document.createElement('small');
    details.textContent = week.days.map(day => `${day.date} ${day.status === 'empty' ? 'ยังไม่ลง' : `ลง ${hoursLabel(day.seconds)}`}`).join(' · ');
    button.append(heading, amount, details);
    button.onclick = () => { $('weekDate').value = week.weekStart; loadWeekly(); };
    return button;
  });
  if (!cards.length) {
    const empty = document.createElement('p');
    empty.className = 'weekly-alert-empty';
    empty.textContent = 'ไม่มีสัปดาห์ที่ขาดเวลาในปีนี้';
    cards.push(empty);
  }
  $('alertRows').replaceChildren(...cards);
}

async function loadAlerts(force = false) {
  if (!jiraConfigured || alertBusy) return;
  const year = Number($('alertYear').value);
  const weeks = Number($('alertRange').value);
  if (!Number.isInteger(year) || year < 2021 || year > Number($('alertYear').max)) {
    $('alertMessage').textContent = 'เลือกปีตั้งแต่ 2021 ถึงปีปัจจุบัน';
    return;
  }
  const requestId = ++alertRequest;
  const button = force ? $('botRefresh') : $('alertReload');
  alertBusy = true;
  $('botRefresh').disabled = true;
  $('alertReload').disabled = true;
  setBusy(button, true, 'กำลังตรวจ…');
  $('alertMessage').textContent = 'กำลังซิงก์วันหยุด BOT และอ่าน worklog จาก Jira…';
  try {
    const data = await call(`/api/worklogs/alerts?year=${year}&weeks=${weeks}${force ? '&refresh=1' : ''}`);
    if (requestId !== alertRequest || Number($('alertYear').value) !== year || Number($('alertRange').value) !== weeks) return;
    alertLoadedKey = `${year}:${weeks}`;
    renderAlerts(data);
  } catch (error) {
    $('alertMessage').textContent = error.message;
    $('alertCount').textContent = 'ตรวจไม่ได้';
    $('alertRows').replaceChildren();
  } finally {
    alertBusy = false;
    setBusy(button, false, '');
    $('botRefresh').disabled = false;
    $('alertReload').disabled = false;
    if (location.hash === '#weekly' && `${$('alertYear').value}:${$('alertRange').value}` !== `${year}:${weeks}`) loadAlerts();
  }
}

$('alertYear').onchange = () => loadAlerts();
$('alertRange').onchange = () => loadAlerts();
$('alertReload').onclick = () => loadAlerts();
$('botRefresh').onclick = () => loadAlerts(true);

function visibleIssues() {
  const query = $('filter').value.toLowerCase();
  const status = $('status').value;
  const type = $('issueType').value;
  const syncFilter = $('issueSyncFilter').value;
  const sentKeys = new Set(syncHistory.filter(item => item.status === 'synced' && item.date === $('defaultDate').value).map(item => item.issue));
  return issues.filter(issue =>
    (!status || issue.status === status) &&
    (!type || issue.type === type) &&
    (!syncFilter || (syncFilter === 'sent') === sentKeys.has(issue.key)) &&
    [issue.key, issue.summary, issue.status, ...(issue.boards || [])].join(' ').toLowerCase().includes(query)
  );
}

function syncIssueSelectAll(filtered) {
  const checkbox = $('issueSelectAll');
  const selectable = filtered.filter(isLoggable);
  const selectedCount = selectable.filter(issue => selected.has(issue.key)).length;
  checkbox.checked = selectable.length > 0 && selectedCount === selectable.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  checkbox.disabled = selectable.length === 0;
}

function renderIssues() {
  const filtered = visibleIssues();
  const body = $('issueRows');
  body.replaceChildren();

  if (!filtered.length) {
    const row = document.createElement('tr');
    const empty = cell(row, issues.length ? 'ไม่พบ Issue ที่ตรงกับตัวกรอง' : 'บอร์ดที่เลือกไม่มี Issue');
    empty.colSpan = 8;
    empty.className = 'empty-state';
    body.append(row);
  }

  for (const issue of filtered) {
    const row = document.createElement('tr');
    const loggable = isLoggable(issue);
    if (!loggable) selected.delete(issue.key);
    row.classList.toggle('selected', selected.has(issue.key));
    row.classList.toggle('not-loggable', !loggable);
    const checkCell = cell(row, '');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'check';
    checkbox.setAttribute('aria-label', `เลือก ${issue.key}`);
    checkbox.checked = selected.has(issue.key);
    checkbox.disabled = !loggable;
    if (!loggable) checkbox.title = 'ลงเวลาได้เฉพาะ Task และ Sub-task';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(issue.key);
      else selected.delete(issue.key);
      row.classList.toggle('selected', checkbox.checked);
      syncIssueSelectAll(filtered);
      updateMetrics();
    });
    checkCell.append(checkbox);
    cell(row, issue.key, 'issue-key');
    cell(row, (issue.boards || []).join(', '), 'board-cell');
    cell(row, issue.summary, 'summary-cell');
    cell(row, loggable ? issue.type : `${issue.type} · ลงเวลาไม่ได้`, 'muted-cell');
    const statusCell = cell(row, '');
    const pill = document.createElement('span');
    pill.className = 'status-pill';
    pill.textContent = issue.status;
    statusCell.append(pill);
    const issueHistory = syncHistory.filter(item => item.issue === issue.key);
    const syncedCount = issueHistory.filter(item => item.status === 'synced').length;
    const historyCell = cell(row, '');
    const historyBadge = document.createElement('span');
    historyBadge.className = `sync-pill ${issueHistory.some(item => item.status === 'uncertain') ? 'uncertain' : syncedCount ? 'synced' : issueHistory.some(item => item.status === 'retry_ready') ? 'retry_ready' : 'empty'}`;
    historyBadge.textContent = issueHistory.some(item => item.status === 'uncertain')
      ? 'ต้องตรวจสอบ' : syncedCount ? `บันทึกแล้ว ${syncedCount}` : issueHistory.some(item => item.status === 'retry_ready') ? 'ไม่พบรายการตรงกัน' : 'ไม่มีประวัติ';
    historyCell.append(historyBadge);
    cell(row, issue.assignee, 'muted-cell');
    body.append(row);
  }
  $('count').textContent = `${filtered.length} / ${issues.length}`;
  syncIssueSelectAll(filtered);
  updateMetrics();
}

function renderEntries() {
  const body = $('entries');
  body.replaceChildren();

  if (!entries.length) {
    const row = document.createElement('tr');
    const empty = cell(row, 'เลือก Issues ด้านบน แล้วกด “เพิ่มงานที่เลือก”');
    empty.colSpan = 5;
    empty.className = 'empty-state';
    body.append(row);
  }

  for (const [index, entry] of entries.entries()) {
    const row = document.createElement('tr');
    const issueCell = cell(row, entry.issue, 'issue-key');
    const priorOnDate = syncHistory.some(item => item.issue === entry.issue && item.date === entry.date && item.status === 'synced');
    const queueBadge = document.createElement('span');
    queueBadge.className = `sync-pill ${priorOnDate ? 'uncertain' : 'empty'}`;
    queueBadge.textContent = priorOnDate ? 'เคยส่งวันนี้ · ตรวจซ้ำ' : 'รอส่ง';
    issueCell.append(document.createElement('br'), queueBadge);
    cell(row, '').append(control('date', entry.date, value => entry.date = value));
    cell(row, '').append(control('number', entry.hours, value => entry.hours = value, { min: '0.01', max: '24', step: 'any' }));
    cell(row, '').append(control('text', entry.description, value => entry.description = value, { class: 'entry-description', maxlength: '2000', placeholder: 'งานที่ทำจริง' }));
    const actions = cell(row, '');
    const remove = document.createElement('button');
    remove.textContent = 'ลบ';
    remove.className = 'ghost danger';
    remove.setAttribute('aria-label', `ลบ Worklog ${entry.issue}`);
    remove.onclick = () => {
      entries.splice(index, 1);
      invalidate();
      renderEntries();
    };
    actions.append(remove);
    body.append(row);
  }
  updateMetrics();
}

$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (entries.length && !confirm('การบันทึกการตั้งค่าจะล้างรายการ Worklog ที่ยังไม่ส่ง ดำเนินการต่อ?')) return;
  const button = $('saveSettings');
  try {
    setBusy(button, true, 'กำลังบันทึก…');
    const data = await call('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf },
      body: JSON.stringify({
        baseUrl: $('settingUrl').value,
        email: $('settingEmail').value,
        token: $('settingToken').value,
        timezone: $('settingTimezone').value,
        boardIds: $('settingBoardIds').value
      })
    });
    applySettings(data);
    issues = [];
    entries = [];
    selected.clear();
    boardIds = [];
    $('boardInfo').textContent = '';
    $('tasksPanel').classList.add('hide');
    $('entryPanel').classList.add('hide');
    invalidate();
    updateMetrics();
    settingsMsg('บันทึกแล้ว · ค่าจะอยู่บนเครื่องนี้เมื่อเปิดแอปครั้งถัดไป', 'good');
    msg('ตั้งค่า Jira แล้ว · ใส่ Board ID เพื่อโหลดงาน', 'good');
  } catch (error) {
    settingsMsg(error.message, 'bad');
  } finally {
    setBusy(button, false, '');
  }
});

$('mappingAdd').onclick = () => {
  const next = mappingDraft().rules;
  if (next.length >= 30) return;
  next.push({ name: '', terms: [], issue: '', isLeave: false });
  renderMappingRules(next);
  mappingChanged();
  $('mappingRules').lastElementChild.querySelector('[data-field="name"]').focus();
};

$('mappingFallback').addEventListener('input', () => {
  $('mappingFallbackStatus').textContent = 'ยังไม่ตรวจสอบการเปลี่ยนแปลง';
  $('mappingFallbackStatus').className = 'mapping-status';
  mappingChanged();
});

$('mappingPreview').onclick = async () => {
  const button = $('mappingPreview');
  try {
    setBusy(button, true, 'กำลังทดสอบ…');
    const result = await call('/api/settings/calendar-mappings/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf },
      body: JSON.stringify({ title: $('mappingExample').value, ...mappingDraft() })
    });
    $('mappingPreviewResult').textContent = `${result.rule} → ${result.issue} · ยังไม่ได้บันทึก`;
    $('mappingPreviewResult').className = 'good';
  } catch (error) {
    $('mappingPreviewResult').textContent = error.message;
    $('mappingPreviewResult').className = 'bad';
  } finally {
    setBusy(button, false, '');
  }
};

$('mappingForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('saveMapping');
  try {
    setBusy(button, true, 'กำลังตรวจการ์ด…');
    const data = await call('/api/settings/calendar-mappings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf },
      body: JSON.stringify(mappingDraft())
    });
    calendarRules = data.calendarRules;
    calendarFallback = data.calendarFallback;
    const summaries = new Map(data.issues.map(issue => [issue.key, issue.summary]));
    renderMappingRules(calendarRules, summaries);
    $('mappingFallback').value = calendarFallback;
    $('mappingFallbackStatus').textContent = `✓ ${calendarFallback}${summaries.get(calendarFallback) ? ` · ${summaries.get(calendarFallback)}` : ''}`;
    $('mappingFallbackStatus').className = 'mapping-status good';
    clearCalendarSelection();
    mappingMsg('บันทึกแล้ว · การดึงประชุมครั้งถัดไปจะใช้การ์ดชุดใหม่นี้', 'good');
  } catch (error) {
    mappingMsg(`ยังไม่บันทึก · ${error.message}`, 'bad');
  } finally {
    setBusy(button, false, '');
  }
});

$('testJira').onclick = async () => {
  const button = $('testJira');
  try {
    setBusy(button, true, 'กำลังทดสอบ…');
    const data = await call('/api/jira/me');
    settingsMsg(`เชื่อมต่อ Jira สำเร็จ · ${data.name}`, 'good');
  } catch (error) {
    settingsMsg(`เชื่อมต่อไม่สำเร็จ · ${error.message}`, 'bad');
  } finally {
    setBusy(button, false, '');
  }
};

$('toggleToken').onclick = () => {
  const visible = $('settingToken').type === 'text';
  $('settingToken').type = visible ? 'password' : 'text';
  $('toggleToken').textContent = visible ? 'แสดง' : 'ซ่อน';
  $('toggleToken').setAttribute('aria-pressed', String(!visible));
};

window.addEventListener('hashchange', showView);

$('load').onclick = async () => {
  const button = $('load');
  try {
    invalidate();
    const requestedBoardIds = parseBoardIds($('boardIds').value);
    setBusy(button, true, 'กำลังโหลด…');
    msg(`กำลังโหลด Issues จาก ${requestedBoardIds.length} บอร์ด…`);
    const data = await call('/api/boards?ids=' + encodeURIComponent(requestedBoardIds.join(',')));
    const loadedBoardIds = data.boards.map(board => String(board.id));
    const failedBoardIds = (data.failedBoards || []).map(board => board.id);
    const nextKeys = new Set(data.issues.map(issue => issue.key));
    const removedEntries = entries.filter(entry => !nextKeys.has(entry.issue));
    if (removedEntries.length && !confirm(`${removedEntries.length} Worklogs ไม่อยู่ในบอร์ดชุดใหม่และจะถูกลบจากคิว ดำเนินการต่อ?`)) return;
    boardIds = loadedBoardIds;
    $('boardIds').value = loadedBoardIds.join(', ');
    issues = data.issues;
    selected.clear();
    entries = entries.filter(entry => nextKeys.has(entry.issue));
    fillIssueFilters();
    $('boardInfo').textContent = `${data.boards.length} บอร์ด · ${issues.length} งานไม่ซ้ำ · ${data.boards.map(board => board.name).join(', ')}${failedBoardIds.length ? ` · ข้าม ${failedBoardIds.join(', ')}` : ''}`;
    $('tasksPanel').classList.remove('hide');
    $('entryPanel').classList.remove('hide');
    renderIssues();
    renderEntries();
    const warning = failedBoardIds.length ? `\nข้ามบอร์ด ${failedBoardIds.join(', ')}: ไม่พบบอร์ดหรือบัญชีไม่มีสิทธิ์ดู` : '';
    saveSession();
    msg(`โหลด ${issues.length} Issues จาก ${data.boards.length} บอร์ดสำเร็จ${removedEntries.length ? ` · ลบ ${removedEntries.length} รายการที่ไม่อยู่ในชุดใหม่` : ''}${warning}`, failedBoardIds.length ? 'bad' : 'good');
  } catch (error) {
    msg(error.message, 'bad');
  } finally {
    setBusy(button, false, '');
  }
};

$('filter').oninput = renderIssues;
$('status').onchange = renderIssues;
$('issueType').onchange = renderIssues;
$('issueSyncFilter').onchange = renderIssues;
$('defaultDate').onchange = renderIssues;
$('issueSelectAll').onchange = event => {
  for (const issue of visibleIssues().filter(isLoggable)) {
    if (event.target.checked) selected.add(issue.key);
    else selected.delete(issue.key);
  }
  renderIssues();
};
$('boardIds').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('load').click();
});

$('add').onclick = () => {
  if (!selected.size) return msg('เลือกอย่างน้อย 1 Issue ก่อนเพิ่มรายการ', 'bad');
  const added = selected.size;
  for (const key of selected) {
    const issue = issues.find(item => item.key === key);
    if (!issue || !isLoggable(issue)) continue;
    entries.push({
      issue: key,
      date: $('defaultDate').value,
      hours: $('defaultHours').value,
      description: issue?.summary || ''
    });
  }
  selected.clear();
  invalidate();
  renderIssues();
  renderEntries();
  msg(`เพิ่ม ${added} Issues ลงคิว Worklog แล้ว`, 'good');
};

function check() {
  if (!entries.length) throw Error('ยังไม่มี Worklog รอส่ง');
  if (parseBoardIds($('boardIds').value).join(',') !== boardIds.join(',')) {
    throw Error('Board IDs เปลี่ยนแล้ว กดโหลดงานจากบอร์ดก่อนตรวจรายการ');
  }
  const issueKeys = new Set(issues.map(issue => issue.key));
  const seen = new Set();
  const sumByDate = {};
  for (const [index, entry] of entries.entries()) {
    if (!issueKeys.has(entry.issue)) throw Error(`แถว ${index + 1}: Issue ไม่อยู่ในบอร์ดที่โหลด`);
    const entryIssue = issues.find(issue => issue.key === entry.issue);
    if (!isLoggable(entryIssue)) throw Error(`แถว ${index + 1}: ${entry.issue} เป็น ${entryIssue.type} ลงเวลาได้เฉพาะ Task และ Sub-task`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw Error(`แถว ${index + 1}: วันที่ไม่ถูกต้อง`);
    const hours = Number(entry.hours);
    if (!(hours > 0 && hours <= 24)) throw Error(`แถว ${index + 1}: ชั่วโมงต้องมากกว่า 0 และไม่เกิน 24`);
    if (!entry.description.trim()) throw Error(`แถว ${index + 1}: กรอกรายละเอียดงาน`);
    const key = JSON.stringify(entry);
    if (seen.has(key)) throw Error(`แถว ${index + 1}: รายการซ้ำ`);
    seen.add(key);
    sumByDate[entry.date] = (sumByDate[entry.date] || 0) + hours;
  }
  return sumByDate;
}

$('preview').onclick = () => {
  try {
    const totals = check();
    validated = true;
    $('submit').disabled = false;
    const daily = Object.entries(totals).sort().map(([date, hours]) => `${date}  ·  ${hours.toFixed(2)} ชั่วโมง`).join('\n');
    msg(`ตรวจสอบผ่าน — ยังไม่ได้ส่งเข้า Jira\n${daily}\nตรวจรายการด้านบน แล้วกด “บันทึกลง Jira”`, 'good');
  } catch (error) {
    invalidate();
    msg(error.message, 'bad');
  }
};

$('submit').onclick = async () => {
  if (!validated) return;
  const button = $('submit');
  try {
    check();
    if (!confirm(`บันทึก ${entries.length} Worklogs ลง Jira จริง?`)) return;
    invalidate();
    setBusy(button, true, 'กำลังบันทึก…');
    msg('กำลังส่ง Worklogs เข้า Jira ทีละรายการ…');
    const result = await call('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf },
      body: JSON.stringify({ boardIds, entries })
    });
    weeklyCache.clear();
    const labels = { created: 'บันทึกแล้ว', skipped: 'ข้ามรายการซ้ำ', needs_review: 'ต้องตรวจ Jira ก่อนลองใหม่', check_failed: 'ตรวจประวัติ Jira ไม่สำเร็จ', uncertain_or_failed: 'ไม่สำเร็จหรือไม่แน่ชัด' };
    const details = result.results.map(row =>
      `${row.issue} ${row.date}: ${labels[row.result] || row.result}${row.id ? ` (ID ${row.id})` : ''}${row.error ? ` — ${row.error}` : ''}`
    ).join('\n');
    const stopped = result.stopped ? '\nหยุดการส่ง — ตรวจสอบประวัติใน Jira ก่อนลองใหม่' : '\nส่งครบทุกแถวแล้ว ตรวจสอบประวัติ Worklog ใน Jira อีกครั้ง';
    msg(details + stopped, result.stopped ? 'bad' : 'good');
    await refreshHistory();
  } catch (error) {
    msg(error.message, 'bad');
  } finally {
    setBusy(button, false, '');
    invalidate();
  }
};

$('historyFilter').oninput = renderHistory;
$('historyStatus').onchange = renderHistory;
$('historyReload').onclick = refreshHistory;
$('historyReconcile').onclick = async () => {
  const button = $('historyReconcile');
  try {
    setBusy(button, true, 'กำลังตรวจ Jira…');
    const result = await call('/api/history/reconcile', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf }, body: '{}'
    });
    weeklyCache.clear();
    await refreshHistory();
    $('historyMessage').textContent = `ตรวจ ${result.checked} รายการ · พบใน Jira ${result.synced} · ไม่พบรายการตรงกัน ${result.retryReady}${result.errors.length ? ` · ตรวจไม่ได้: ${result.errors.join('; ')}` : ''}`;
  } catch (error) {
    $('historyMessage').textContent = error.message;
  } finally {
    setBusy(button, false, '');
  }
};

// Per-tab snapshot in sessionStorage so a page refresh keeps loaded boards, queued worklogs and review results.
// It is cleared when the tab closes and never holds credentials or the CSRF token.
const sessionKey = 'worklogStudio.session.v1', sessionMaxAge = 12 * 60 * 60 * 1000;
let sessionReady = false;

function saveSession() {
  if (!sessionReady) return;
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({
      savedAt: Date.now(),
      board: {
        boardIds, inputIds: $('boardIds').value, info: $('boardInfo').textContent, issues, entries,
        selected: [...selected], hours: $('defaultHours').value, filter: $('filter').value,
        status: $('status').value, type: $('issueType').value, syncFilter: $('issueSyncFilter').value
      },
      weekly: { date: $('weekDate').value, cache: [...weeklyCache] },
      calendar: {
        proposals: calendarProposals, loadedDate: calendarLoadedDate, loadedIds: calendarLoadedIds,
        holidays: [...calendarHolidayDates], existing: calendarExistingDays,
        selectedIds: currentCalendarSelection(), date: $('calendarDate').value, syncFilter: $('calendarSyncFilter').value
      }
    }));
  } catch (error) { /* storage blocked or full: nothing to keep */ }
}

function restoreSession() {
  let snapshot = null;
  try { snapshot = JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch (error) { console.warn('session restore: unreadable', error); return 'unreadable'; }
  if (!snapshot) return 'empty';
  if (!(Date.now() - snapshot.savedAt < sessionMaxAge)) return 'expired';
  try {
    const { board, weekly, calendar } = snapshot;
    if (Array.isArray(board.issues) && board.issues.length) {
      boardIds = board.boardIds;
      issues = board.issues;
      entries = board.entries;
      const loggableKeys = new Set(issues.filter(isLoggable).map(issue => issue.key));
      selected = new Set(board.selected.filter(key => loggableKeys.has(key)));
      entries = entries.filter(entry => loggableKeys.has(entry.issue));
      $('boardIds').value = board.inputIds;
      $('boardInfo').textContent = board.info;
      $('defaultHours').value = board.hours;
      $('filter').value = board.filter;
      fillIssueFilters();
      $('status').value = board.status;
      $('issueType').value = board.type || '';
      $('issueSyncFilter').value = board.syncFilter;
      $('tasksPanel').classList.remove('hide');
      $('entryPanel').classList.remove('hide');
      renderIssues();
      renderEntries();
    }
    if (weekly.date) $('weekDate').value = weekly.date;
    for (const [key, value] of weekly.cache) {
      if (Date.now() - value.time < weeklyCacheTtl) weeklyCache.set(key, value);
    }
    if (calendar.date) $('calendarDate').value = calendar.date;
    // Checkboxes are created when the Calendar view opens; loadCalendarList re-ticks these ids.
    calendarRestoredIds = calendar.selectedIds || calendar.loadedIds || [];
    $('calendarSyncFilter').value = calendar.syncFilter;
    if (Array.isArray(calendar.proposals) && calendar.proposals.length) {
      calendarProposals = calendar.proposals;
      calendarLoadedDate = calendar.loadedDate;
      calendarLoadedIds = calendar.loadedIds;
      calendarHolidayDates = new Set(calendar.holidays);
      calendarExistingDays = calendar.existing;
      $('calendarResults').classList.remove('hide');
      renderCalendarRows();
    }
    return 'restored';
  } catch (error) {
    console.warn('session restore failed', error);
    sessionStorage.removeItem(sessionKey);
    return 'failed';
  }
}

window.addEventListener('pagehide', saveSession);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });

(async () => {
  renderEntries();
  updateMetrics();
  showView();
  try {
    const data = await call('/api/config');
    csrf = data.csrf;
    applySettings(data);
    const restored = restoreSession();
    sessionReady = true;
    showView();
    await refreshHistory();
    if (!data.configured && !location.hash) location.hash = 'settings';
    settingsMsg(data.configured ? 'ตั้งค่าแล้ว · ทดสอบการเชื่อมต่อก่อนใช้งานได้' : 'กรอกข้อมูลแล้วกดบันทึกการตั้งค่า');
    const restoreNote = { restored: `กู้คืนข้อมูลเดิม ${issues.length} Issues · ${entries.length} รายการรอส่ง`, expired: 'ข้อมูลเดิมหมดอายุ', failed: 'กู้คืนข้อมูลเดิมไม่สำเร็จ (ดู Console)', unreadable: 'อ่านข้อมูลเดิมไม่ได้ (ดู Console)' }[restored];
    msg((data.configured ? `พร้อมใช้งาน · Timezone ${data.timezone}` : 'ยังไม่มีข้อมูลเชื่อมต่อ Jira · ไปที่ตั้งค่า Jira') + (restoreNote ? ` · ${restoreNote}` : ''), data.configured ? 'good' : 'neutral');
  } catch (error) {
    msg(error.message, 'bad');
    settingsMsg(error.message, 'bad');
  }
})();
