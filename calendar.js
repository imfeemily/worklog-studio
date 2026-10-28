'use strict';

let calendarStatusLoaded = false;
let calendarProposals = [];
let calendarLoadedDate = '';
let calendarLoadedIds = [];
let calendarRestoredIds = [];
let calendarValidated = false;
let calendarLoadNumber = 0;
let calendarExistingDays = null;
let calendarHolidayDates = new Set();
let calendarTodayBusy = false;
let calendarSubmitting = false;

function calendarMessage(text, tone = '') {
  $('calendarMessage').textContent = text;
  $('calendarMessage').className = `weekly-message ${tone}`;
}

function selectedCalendarIds() {
  return [...document.querySelectorAll('#calendarList input:checked')].map(input => input.value);
}

// Ticked calendars once the list exists; before that, the ids waiting to be restored.
function currentCalendarSelection() {
  return document.querySelector('#calendarList input') ? selectedCalendarIds() : calendarRestoredIds;
}

function calendarTodayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: $('settingTimezone').value || 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function syncCalendarSelectAll() {
  const inputs = [...document.querySelectorAll('#calendarList input[type="checkbox"]')];
  const selectedCount = inputs.filter(input => input.checked).length;
  const checkbox = $('calendarSelectAll');
  checkbox.checked = inputs.length > 0 && selectedCount === inputs.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < inputs.length;
  checkbox.disabled = inputs.length === 0;
}

function clearCalendarSelection() {
  calendarProposals = [];
  calendarExistingDays = null;
  calendarHolidayDates = new Set();
  $('calendarResults').classList.add('hide');
  resetCalendarPreview();
}

function resetCalendarPreview() {
  calendarValidated = false;
  $('calendarSubmit').disabled = true;
  const selected = calendarProposals.filter(row => row.selected);
  const totalMinutes = selected.reduce((sum, row) => sum + (Number(row.minutes) || 0), 0);
  $('calendarTotal').textContent = selected.length
    ? `${selected.length} รายการ · ${(totalMinutes / 60).toFixed(2)} ชั่วโมงที่เลือก`
    : 'ยังไม่ได้เลือกรายการ';
  if (calendarExistingDays) {
    $('calendarExisting').textContent = 'Jira เดิม + ที่เลือก / เป้าตาม BOT: ' + calendarExistingDays.map(day => {
      const chosenMinutes = selected.filter(row => row.date === day.date)
        .reduce((sum, row) => sum + (Number(row.minutes) || 0), 0);
      return `${day.date} ${((day.seconds + chosenMinutes * 60) / 3600).toFixed(2)} / ${(day.targetSeconds / 3600).toFixed(0)} ชม.${day.holidayName ? ' (วันหยุด)' : ''}`;
    }).join(' · ');
  }
}

async function calendarViewOpened() {
  if (calendarStatusLoaded) return;
  calendarStatusLoaded = true;
  try {
    const data = await call('/api/calendar/status');
    if (data.status === 'fullAccess') {
      $('calendarAccessBadge').textContent = 'อ่าน Calendar ได้';
      $('calendarAccessBadge').classList.add('ready');
      $('calendarAccessMessage').textContent = 'เลือกปฏิทินบริษัทที่ต้องการอ่าน';
      await loadCalendarList();
    } else if (data.status === 'notDetermined') {
      $('calendarAccessBadge').textContent = 'ยังไม่ได้อนุญาต';
      $('calendarAuthorize').classList.remove('hide');
      $('calendarAccessMessage').textContent = 'กดอนุญาต แล้วตอบหน้าต่างสิทธิ์ของ macOS';
    } else {
      calendarStatusLoaded = false;
      $('calendarAccessBadge').textContent = 'อ่านไม่ได้';
      $('calendarAccessMessage').textContent = 'เปิด System Settings > Privacy & Security > Calendars แล้วให้ Full Access กับ Worklog Studio Calendar Reader จากนั้นเปิดหน้านี้ใหม่';
    }
  } catch (error) {
    calendarStatusLoaded = false;
    $('calendarAccessBadge').textContent = 'เชื่อมต่อไม่ได้';
    $('calendarAccessMessage').textContent = error.message;
  }
}

async function loadCalendarList() {
  const data = await call('/api/calendar/calendars');
  const container = $('calendarList');
  const previous = new Set([...selectedCalendarIds(), ...calendarRestoredIds]);
  calendarRestoredIds = [];
  const items = (data.calendars || []).map(calendar => {
    const label = document.createElement('label');
    label.className = 'calendar-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = calendar.id;
    input.checked = previous.has(calendar.id);
    input.addEventListener('change', () => {
      syncCalendarSelectAll();
      clearCalendarSelection();
      saveSession();
    });
    const details = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = calendar.title;
    const source = document.createElement('small');
    source.textContent = calendar.source;
    details.append(title, source);
    label.append(input, details);
    return label;
  });
  container.replaceChildren(...items);
  syncCalendarSelectAll();
  if (!items.length) $('calendarAccessMessage').textContent = 'Mac Calendar ยังไม่มีปฏิทินให้เลือก';
}

function calendarShift(days) {
  const current = new Date(`${$('calendarDate').value}T12:00:00Z`);
  current.setUTCDate(current.getUTCDate() + days);
  $('calendarDate').value = current.toISOString().slice(0, 10);
  calendarProposals = [];
  calendarExistingDays = null;
  calendarHolidayDates = new Set();
  $('calendarResults').classList.add('hide');
  resetCalendarPreview();
}

function selectableCalendarProposals() {
  return visibleCalendarProposals().filter(proposal => {
    const previous = syncHistory.find(item => item.eventKey === proposal.eventKey);
    return !previous || previous.status === 'retry_ready';
  });
}

function visibleCalendarProposals() {
  const syncFilter = $('calendarSyncFilter').value;
  return calendarProposals.filter(proposal => {
    const sent = syncHistory.some(item => item.eventKey === proposal.eventKey && item.status === 'synced');
    return !syncFilter || (syncFilter === 'sent') === sent;
  });
}

function syncCalendarRowsSelectAll() {
  const selectable = selectableCalendarProposals();
  const selectedCount = selectable.filter(proposal => proposal.selected).length;
  const checkbox = $('calendarRowsSelectAll');
  checkbox.checked = selectable.length > 0 && selectedCount === selectable.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  checkbox.disabled = selectable.length === 0;
}

function renderCalendarRows() {
  const visible = visibleCalendarProposals();
  const visibleSet = new Set(visible);
  for (const proposal of calendarProposals) if (!visibleSet.has(proposal)) proposal.selected = false;
  const rows = visible.map(proposal => {
    const tr = document.createElement('tr');
    const previous = syncHistory.find(item => item.eventKey === proposal.eventKey);
    if (previous && previous.status !== 'retry_ready') proposal.selected = false;
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'check';
    checkbox.checked = Boolean(proposal.selected);
    checkbox.disabled = Boolean(previous && previous.status !== 'retry_ready');
    checkbox.setAttribute('aria-label', `เลือก ${proposal.title} ${proposal.date}`);
    checkbox.onchange = () => { proposal.selected = checkbox.checked; syncCalendarRowsSelectAll(); resetCalendarPreview(); };
    selectCell.append(checkbox);
    const titleCell = document.createElement('td');
    titleCell.className = 'calendar-event-cell';
    const title = document.createElement('strong');
    title.textContent = proposal.title;
    const time = document.createElement('small');
    if (proposal.allDay) time.textContent = 'ทั้งวัน';
    else {
      const format = value => new Date(value).toLocaleTimeString('th-TH', {
        hour: '2-digit', minute: '2-digit', timeZone: $('settingTimezone').value || 'Asia/Bangkok'
      });
      time.textContent = `${format(proposal.start)}–${format(proposal.end)}`;
    }
    titleCell.append(title, time);
    const badge = document.createElement('span');
    badge.className = `sync-pill ${previous?.status || 'empty'}`;
    badge.textContent = previous
      ? ({ uncertain: 'ต้องตรวจสอบใน Jira', retry_ready: 'ไม่พบรายการตรงกัน · ส่งได้', synced: 'บันทึกแล้ว · ไม่ส่งซ้ำ' }[previous.status] || previous.status)
      : 'ไม่มีประวัติในแอป';
    titleCell.append(badge);
    if (proposal.warning) {
      const warning = document.createElement('small');
      warning.className = 'calendar-warning';
      warning.textContent = proposal.warning;
      titleCell.append(warning);
    }
    const dateCell = document.createElement('td');
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'entry-input';
    dateInput.value = proposal.date;
    dateInput.oninput = () => { proposal.date = dateInput.value; resetCalendarPreview(); };
    dateCell.append(dateInput);
    const issueCell = document.createElement('td');
    const issueSelect = document.createElement('select');
    issueSelect.className = 'entry-input';
    issueSelect.append(new Option('เลือกการ์ด', ''));
    for (const issue of calendarRuleIssues()) {
      issueSelect.append(new Option(issue, issue));
    }
    issueSelect.value = proposal.issue;
    issueSelect.onchange = () => { proposal.issue = issueSelect.value; resetCalendarPreview(); };
    issueCell.append(issueSelect);
    const minutesCell = document.createElement('td');
    const minutesInput = document.createElement('input');
    minutesInput.type = 'number';
    minutesInput.min = '1';
    minutesInput.max = '1440';
    minutesInput.step = '1';
    minutesInput.className = 'entry-input calendar-minutes';
    minutesInput.value = proposal.minutes;
    minutesInput.setAttribute('aria-label', `นาที ${proposal.title}`);
    minutesInput.oninput = () => { proposal.minutes = Number(minutesInput.value); resetCalendarPreview(); };
    minutesCell.append(minutesInput);
    const descriptionCell = document.createElement('td');
    const descriptionInput = document.createElement('input');
    descriptionInput.className = 'entry-input entry-description';
    descriptionInput.maxLength = 2000;
    descriptionInput.value = proposal.description;
    descriptionInput.setAttribute('aria-label', `รายละเอียด ${proposal.title}`);
    descriptionInput.oninput = () => { proposal.description = descriptionInput.value; resetCalendarPreview(); };
    descriptionCell.append(descriptionInput);
    tr.append(selectCell, titleCell, dateCell, issueCell, minutesCell, descriptionCell);
    return tr;
  });
  if (!rows.length) {
    const empty = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-state';
    cell.textContent = calendarProposals.length ? 'ไม่พบประชุมที่ตรงกับตัวกรอง' : 'ไม่พบประชุมในสัปดาห์นี้';
    empty.append(cell);
    rows.push(empty);
  }
  $('calendarRows').replaceChildren(...rows);
  $('calendarCount').textContent = `${visible.length} / ${calendarProposals.length} รายการ`;
  syncCalendarRowsSelectAll();
  resetCalendarPreview();
}

async function loadCalendarWeek() {
  const ids = selectedCalendarIds();
  if (!ids.length) return calendarMessage('เลือกปฏิทินบริษัทอย่างน้อย 1 ปฏิทินก่อน', 'bad');
  if (!$('calendarDate').value) return calendarMessage('เลือกวันที่ในสัปดาห์ก่อน', 'bad');
  const requestedDate = $('calendarDate').value;
  const requestNumber = ++calendarLoadNumber;
  const button = $('calendarLoad');
  setBusy(button, true, 'กำลังอ่าน…');
  calendarMessage('กำลังอ่านเหตุการณ์จาก Mac Calendar…');
  calendarProposals = [];
  calendarExistingDays = null;
  calendarHolidayDates = new Set();
  $('calendarResults').classList.add('hide');
  try {
    const data = await call(`/api/calendar/week?date=${encodeURIComponent(requestedDate)}&ids=${encodeURIComponent(ids.join(','))}`);
    if (requestNumber !== calendarLoadNumber) return;
    if (selectedCalendarIds().join(',') !== ids.join(',') || $('calendarDate').value !== requestedDate) {
      return calendarMessage('ปฏิทินหรือวันที่เปลี่ยนแล้ว กดดึงประชุมอีกครั้ง');
    }
    calendarLoadedDate = data.weekStart;
    calendarLoadedIds = ids;
    $('calendarDate').value = data.weekStart;
    calendarHolidayDates = new Set(data.holidayDates || []);
    calendarProposals = data.proposals.map(proposal => ({ ...proposal, selected: false }));
    renderCalendarRows();
    $('calendarResults').classList.remove('hide');
    const holidayNote = data.excludedHolidayCount ? ` · ตัด ${data.excludedHolidayCount} รายการตรงวันหยุด BOT` : '';
    const staleNote = (data.botYears || []).some(item => item.stale) ? ' · ใช้วันหยุด BOT จากแคชเก่า' : '';
    calendarMessage(`พบ ${calendarProposals.length} รายการเสนอ · แสดง ${visibleCalendarProposals().length} รายการตามตัวกรอง${holidayNote}${staleNote} · ยังไม่มีรายการใดถูกเลือก`, 'good');
    $('calendarExisting').textContent = 'กำลังตรวจเวลาที่มีใน Jira…';
    try {
      const existing = await call('/api/worklogs/week?date=' + encodeURIComponent(data.weekStart));
      if (requestNumber !== calendarLoadNumber) return;
      calendarExistingDays = existing.days;
      resetCalendarPreview();
    } catch (error) {
      if (requestNumber !== calendarLoadNumber) return;
      $('calendarExisting').textContent = `ตรวจ Jira เดิมไม่ได้: ${error.message} · ตรวจประวัติ Jira เองก่อนลงเวลา`;
    }
    saveSession();
    return Boolean(calendarExistingDays);
  } catch (error) {
    if (requestNumber !== calendarLoadNumber) return;
    calendarMessage(error.message, 'bad');
    return false;
  } finally {
    if (requestNumber === calendarLoadNumber) setBusy(button, false, '');
  }
}

function checkedCalendarEntries() {
  const selected = calendarProposals.filter(row => row.selected);
  if (!selected.length) throw Error('เลือกอย่างน้อย 1 รายการก่อน');
  if (selectedCalendarIds().join(',') !== calendarLoadedIds.join(',') || $('calendarDate').value !== calendarLoadedDate) {
    throw Error('ปฏิทินหรือสัปดาห์เปลี่ยนแล้ว กดดึงประชุมใหม่ก่อน');
  }
  const today = calendarTodayDate();
  for (const row of selected) {
    if (!Number.isInteger(row.minutes) || row.minutes < 1 || row.minutes > 1440) throw Error(`${row.title}: นาทีต้องเป็นจำนวนเต็ม 1–1440`);
    if (!calendarRuleIssues().includes(row.issue)) throw Error(`${row.title}: เลือก Jira task ที่ตั้งค่าไว้`);
    if (!row.date || row.date > today) throw Error(`${row.title}: ไม่ลงเวลาในอนาคต`);
    if (calendarHolidayDates.has(row.date)) throw Error(`${row.title}: วันที่เลือกตรงกับวันหยุด BOT`);
    if (!row.description.trim()) throw Error(`${row.title}: กรอกรายละเอียดงาน`);
  }
  return selected.map(row => ({ eventKey: row.eventKey, issue: row.issue, date: row.date,
    minutes: row.minutes, description: row.description.trim() }));
}

function todaySyncCandidates(today, now) {
  const todayRows = calendarProposals.filter(row => row.date === today);
  const eligible = todayRows.filter(row => {
    const previous = syncHistory.find(item => item.eventKey === row.eventKey);
    return (!previous || previous.status === 'retry_ready') && !row.allDay &&
      calendarRuleIssues().includes(row.issue) && Number.isInteger(row.minutes) &&
      row.minutes > 0 && row.minutes <= 1440 && Boolean(row.description.trim());
  });
  return { todayRows, eligible };
}

function confirmTodaySync(rows, summary) {
  const dialog = $('todaySyncDialog');
  $('todaySyncSummary').textContent = summary;
  const body = $('todaySyncRows');
  body.replaceChildren();
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    cell(tr, String(index + 1));
    cell(tr, row.title);
    cell(tr, row.issue);
    cell(tr, String(row.minutes));
    cell(tr, row.warning || '');
    body.append(tr);
  });
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

async function submitCalendarRows(selected, button) {
  calendarSubmitting = true;
  resetCalendarPreview();
  setBusy(button, true, 'กำลังบันทึก…');
  calendarMessage('กำลังบันทึก Jira ทีละรายการ…');
  try {
    const data = await call('/api/calendar/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf },
      body: JSON.stringify({ date: calendarLoadedDate, calendarIds: calendarLoadedIds, entries: selected })
    });
    weeklyCache.clear();
    const labels = { created: 'บันทึกแล้ว', skipped: 'ข้ามรายการที่เคยส่ง', needs_review: 'ต้องตรวจ Jira ก่อนลองใหม่', check_failed: 'ตรวจประวัติ Jira ไม่สำเร็จ', uncertain_or_failed: 'ไม่สำเร็จหรือไม่แน่ชัด' };
    calendarMessage(data.results.map(row => `${row.date} ${row.issue}: ${labels[row.result]}${row.error ? ` · ${row.error}` : ''}`).join('\n') +
      (data.stopped ? '\nหยุดส่ง · ตรวจประวัติ Jira ก่อนลองใหม่' : '\nตรวจประวัติ Jira อีกครั้ง'), data.stopped ? 'bad' : 'good');
    calendarProposals.forEach(row => { row.selected = false; });
    await refreshHistory();
    renderCalendarRows();
    saveSession();
  } catch (error) {
    calendarMessage(error.message, 'bad');
  } finally {
    setBusy(button, false, '');
    calendarSubmitting = false;
    resetCalendarPreview();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('calendarSelectAll').onchange = event => {
    for (const input of document.querySelectorAll('#calendarList input[type="checkbox"]')) input.checked = event.target.checked;
    syncCalendarSelectAll();
    clearCalendarSelection();
    saveSession();
  };
  $('calendarRowsSelectAll').onchange = event => {
    for (const proposal of selectableCalendarProposals()) proposal.selected = event.target.checked;
    renderCalendarRows();
  };
  $('calendarSyncFilter').onchange = renderCalendarRows;
  $('calendarAuthorize').onclick = async () => {
    const button = $('calendarAuthorize');
    try {
      setBusy(button, true, 'รอการอนุญาต…');
      const data = await call('/api/calendar/authorize', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worklog-CSRF': csrf }, body: '{}'
      });
      if (data.status !== 'fullAccess') throw Error('ยังไม่ได้ให้ Full Calendar Access ใน macOS');
      button.classList.add('hide');
      calendarStatusLoaded = false;
      await calendarViewOpened();
    } catch (error) {
      $('calendarAccessMessage').textContent = error.message;
      calendarMessage(error.message, 'bad');
    } finally {
      setBusy(button, false, '');
    }
  };
  $('calendarPrev').onclick = () => calendarShift(-7);
  $('calendarNext').onclick = () => calendarShift(7);
  $('calendarDate').onchange = clearCalendarSelection;
  $('calendarLoad').onclick = loadCalendarWeek;
  $('calendarToday').onclick = async () => {
    if (calendarTodayBusy || calendarSubmitting) return;
    if (!selectedCalendarIds().length) return calendarMessage('เลือกปฏิทินบริษัทก่อนใช้ Today Sync', 'bad');
    const button = $('calendarToday');
    calendarTodayBusy = true;
    setBusy(button, true, 'กำลังเตรียม Today Sync…');
    try {
      if (!await refreshHistory()) throw Error('อ่านประวัติ Sync ไม่ได้ กรุณาลองใหม่ก่อนส่ง');
      const today = calendarTodayDate();
      $('calendarDate').value = today;
      $('calendarSyncFilter').value = 'unsent';
      if (!await loadCalendarWeek()) {
        if (calendarProposals.length) calendarMessage('Today Sync ต้องตรวจ worklog เดิมใน Jira ได้ก่อน กรุณาตรวจด้วยตนเอง', 'bad');
        return;
      }
      if (calendarTodayDate() !== today) throw Error('วันที่เปลี่ยนระหว่างเตรียมรายการ กรุณาลองใหม่');
      const { todayRows, eligible } = todaySyncCandidates(today, Date.now());
      const skipped = todayRows.length - eligible.length;
      if (!eligible.length) return calendarMessage(`วันนี้ไม่มีประชุมที่พร้อมส่ง · ข้าม ${skipped} รายการที่ส่งแล้ว/ทั้งวัน/ยังไม่ได้จับคู่การ์ด`, 'good');
      if (eligible.length > 100) return calendarMessage(`พบ ${eligible.length} รายการที่พร้อมส่ง · Today Sync จำกัด 100 รายการ กรุณาตรวจและส่งในตาราง`, 'bad');
      for (const row of eligible) row.selected = true;
      renderCalendarRows();
      const existing = calendarExistingDays.find(day => day.date === today);
      const hours = (eligible.reduce((sum, row) => sum + row.minutes, 0) / 60).toFixed(2);
      const existingHours = ((existing?.seconds || 0) / 3600).toFixed(2);
      const warned = eligible.filter(row => row.warning).length;
      const selected = checkedCalendarEntries();
      const summary = `${today} · ${selected.length} รายการ · ${hours} ชม. · Jira เดิม ${existingHours} ชม.` +
        `${warned ? ` · มี warning ${warned} รายการ` : ''} · ข้าม ${skipped} รายการที่ส่งแล้ว/ทั้งวัน/ยังไม่ได้จับคู่การ์ด`;
      if (!await confirmTodaySync(eligible, summary)) {
        calendarMessage('ยกเลิก Today Sync · ยังไม่ได้ส่ง Jira รายการที่เลือกยังอยู่ในตารางให้ตรวจเอง');
        $('calendarResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      await submitCalendarRows(selected, button);
    } catch (error) {
      calendarMessage(error.message, 'bad');
    } finally {
      calendarTodayBusy = false;
      setBusy(button, false, '');
    }
  };
  $('calendarPreview').onclick = () => {
    try {
      const rows = checkedCalendarEntries();
      const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
      calendarValidated = true;
      $('calendarSubmit').disabled = false;
      calendarMessage(`ตรวจสอบผ่าน · ${rows.length} รายการ รวม ${(minutes / 60).toFixed(2)} ชั่วโมง · ยังไม่ได้ส่ง Jira`, 'good');
    } catch (error) {
      resetCalendarPreview();
      calendarMessage(error.message, 'bad');
    }
  };
  $('calendarSubmit').onclick = async () => {
    if (!calendarValidated || calendarSubmitting || calendarTodayBusy) return;
    let selected;
    try { selected = checkedCalendarEntries(); }
    catch (error) { resetCalendarPreview(); return calendarMessage(error.message, 'bad'); }
    if (!confirm(`บันทึก ${selected.length} รายการลง Jira จริง? ตรวจเวลาซ้อนและประวัติ Jira แล้วหรือยัง`)) return;
    await submitCalendarRows(selected, $('calendarSubmit'));
  };
});
