#!/usr/bin/env python3
"""Local Jira Cloud board worklog UI, Python stdlib only."""
import argparse, base64, hashlib, json, os, re, secrets, shutil, subprocess, tempfile, threading, time
from datetime import date, datetime, time as dt_time, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request, error, parse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from calendar_worklogs import DEFAULT_MAPPINGS, legacy_rules, match_rule, propose_events

def parse_jira_time(value):
    # Jira sends offsets like +0700; datetime.fromisoformat only accepts them on Python 3.11+.
    return datetime.strptime(value,'%Y-%m-%dT%H:%M:%S.%f%z')

ROOT = Path(__file__).resolve().parent
VERSION = '0.1.1'
DATA_DIR = Path.home() / 'Library' / 'Application Support' / 'Worklog Studio'
LEDGER = DATA_DIR / '.worklog-ledger.jsonl'
CONFIG = DATA_DIR / '.jira-config.json'
KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]*-\d+$')
# Worklogs are only allowed on plain tasks and sub-tasks, not Epics, Stories, Bugs, etc.
LOGGABLE_TYPES = {'task','sub-task','subtask'}

def loggable_type(name):
    return str(name or '').strip().casefold() in LOGGABLE_TYPES

def require_loggable(key,result):
    type_name=((result.get('fields') or {}).get('issuetype') or {}).get('name') or ''
    if not loggable_type(type_name):
        raise ValueError(f'{key}: ประเภท {type_name or "ไม่ทราบ"} ลง worklog ไม่ได้ · ลงได้เฉพาะ Task และ Sub-task')
LOCK = threading.Lock()
CSRF = secrets.token_urlsafe(32)
LEGACY_CALENDAR_APP = ROOT / '.mac-calendar-helper.app'
CALENDAR_APP = LEGACY_CALENDAR_APP if LEGACY_CALENDAR_APP.is_dir() else DATA_DIR / '.mac-calendar-helper.app'
CALENDAR_HELPER = CALENDAR_APP / 'Contents' / 'MacOS' / 'CalendarReader'
CALENDAR_BUILD_LOCK = threading.Lock()
# `open -W` can fail with "Unable to block on applications ... kevent()" when helper launches overlap or exit too fast.
CALENDAR_RUN_LOCK = threading.Lock()
BOT_CACHE = DATA_DIR / '.bot-holidays.json'
BOT_LOCK = threading.Lock()
BOT_SOURCE = 'https://www.bot.or.th/th/financial-institutions-holiday.html'
BOT_MODEL = 'https://www.bot.or.th/content/bot/th/financial-institutions-holiday/jcr:content/root/container/holidaycalendar_copy.model.{}.json'
BOT_MONTHS = {'มกราคม':1,'กุมภาพันธ์':2,'มีนาคม':3,'เมษายน':4,'พฤษภาคม':5,'มิถุนายน':6,
              'กรกฎาคม':7,'สิงหาคม':8,'กันยายน':9,'ตุลาคม':10,'พฤศจิกายน':11,'ธันวาคม':12}

def prepare_storage(data_dir=DATA_DIR,legacy_dir=ROOT):
    data_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(data_dir,0o700)
    for name in ('.jira-config.json','.worklog-ledger.jsonl','.bot-holidays.json'):
        source=legacy_dir/name
        target=data_dir/name
        if not source.is_file() or target.exists():continue
        temp_path=None
        try:
            with tempfile.NamedTemporaryFile('wb',dir=data_dir,prefix=f'{name}-',suffix='.tmp',delete=False) as temp:
                temp_path=Path(temp.name)
                with source.open('rb') as original:shutil.copyfileobj(original,temp)
                temp.flush();os.fsync(temp.fileno())
            os.chmod(temp_path,0o600)
            try:os.link(temp_path,target)
            except FileExistsError:pass
        finally:
            if temp_path and temp_path.exists():temp_path.unlink()

def parse_board_ids(value, required=True):
    if isinstance(value,str):
        parts=re.split(r'[\s,]+',value.strip()) if value.strip() else []
    elif isinstance(value,list):
        parts=value
    else:
        raise ValueError('Board IDs ต้องเป็นตัวเลขคั่นด้วยจุลภาค')
    board_ids=[]
    for part in parts:
        board_id=str(part).strip()
        if not board_id.isdigit() or not 0<int(board_id)<1000000000:
            raise ValueError('Board IDs ต้องเป็นตัวเลขบวก')
        board_id=str(int(board_id))
        if board_id not in board_ids:board_ids.append(board_id)
    if len(board_ids)>10:raise ValueError('เลือกได้ไม่เกิน 10 บอร์ดต่อครั้ง')
    if required and not board_ids:raise ValueError('กรอก Board ID อย่างน้อย 1 บอร์ด')
    return board_ids

def settings():
    saved=json.loads(CONFIG.read_text(encoding='utf8')) if CONFIG.exists() else {}
    board_ids=saved.get('boardIds')
    if board_ids is None:board_ids=[saved['boardId']] if saved.get('boardId') else []
    stored_mappings=saved.get('calendarMappings')
    mappings={name:stored_mappings.get(name,default) for name,default in DEFAULT_MAPPINGS.items()} if isinstance(stored_mappings,dict) else DEFAULT_MAPPINGS.copy()
    rules=saved.get('calendarRules')
    if not isinstance(rules,list):rules=legacy_rules(mappings)
    return {'baseUrl':saved.get('baseUrl') or os.getenv('JIRA_BASE_URL',''),
            'email':saved.get('email') or os.getenv('JIRA_EMAIL',''),
            'token':saved.get('token') or os.getenv('JIRA_API_TOKEN',''),
            'timezone':saved.get('timezone') or os.getenv('WORKLOG_TIMEZONE','Asia/Bangkok'),
            'boardIds':board_ids,'calendarRules':rules,
            'calendarFallback':saved.get('calendarFallback') or mappings['other']}

def public_settings():
    current=settings()
    return {'baseUrl':current['baseUrl'],'email':current['email'],
            'timezone':current['timezone'],'boardIds':current['boardIds'],
            'calendarRules':current['calendarRules'],'calendarFallback':current['calendarFallback'],
            'hasToken':bool(current['token']),
            'configured':bool(current['baseUrl'] and current['email'] and current['token'])}

def write_settings(values):
    temp_path=None
    try:
        with tempfile.NamedTemporaryFile('w',encoding='utf8',dir=CONFIG.parent,prefix='.jira-config-',suffix='.tmp',delete=False) as temp:
            temp_path=Path(temp.name)
            json.dump(values,temp,ensure_ascii=False)
            temp.flush();os.fsync(temp.fileno())
        os.replace(temp_path,CONFIG)
    finally:
        if temp_path and temp_path.exists():temp_path.unlink()

def normalize_mapping_issue(raw,base_url):
    site=parse.urlsplit(base_url).netloc.lower()
    if not isinstance(raw,str) or not raw.strip() or len(raw)>300:
        raise ValueError('กรอก Issue Key หรือ URL การ์ด Jira')
    issue=raw.strip()
    if issue.lower().startswith('https://'):
        url=parse.urlsplit(issue)
        if url.netloc.lower()!=site or not url.path.startswith('/browse/'):
            raise ValueError('URL การ์ดต้องอยู่ใน Jira site ที่ตั้งค่าไว้')
        issue=url.path.removeprefix('/browse/').rstrip('/').upper()
    else:issue=issue.upper()
    if not KEY_RE.fullmatch(issue):raise ValueError('Issue Key ไม่ถูกต้อง')
    return issue

def normalize_calendar_rules(data,base_url):
    rules=data.get('rules')
    if not isinstance(rules,list) or len(rules)>30:raise ValueError('เพิ่มกฎได้ไม่เกิน 30 รายการ')
    normalized=[]
    for index,rule in enumerate(rules,1):
        if not isinstance(rule,dict):raise ValueError(f'กฎ {index}: ข้อมูลไม่ถูกต้อง')
        name=rule.get('name')
        terms=rule.get('terms')
        if not isinstance(name,str) or not name.strip() or len(name.strip())>80:
            raise ValueError(f'กฎ {index}: กรอกชื่อกฎไม่เกิน 80 ตัวอักษร')
        if not isinstance(terms,list) or not 1<=len(terms)<=15 or any(not isinstance(term,str) or not term.strip() or len(term.strip())>80 for term in terms):
            raise ValueError(f'กฎ {index}: กรอกคำค้น 1–15 คำ คำละไม่เกิน 80 ตัวอักษร')
        if not isinstance(rule.get('isLeave'),bool):raise ValueError(f'กฎ {index}: ประเภทวันลาไม่ถูกต้อง')
        try:issue=normalize_mapping_issue(rule.get('issue'),base_url)
        except ValueError as exc:raise ValueError(f'กฎ {index}: {exc}') from exc
        normalized.append({'name':name.strip(),'terms':[term.strip() for term in terms],
                           'issue':issue,'isLeave':rule['isLeave']})
    try:fallback=normalize_mapping_issue(data.get('fallback'),base_url)
    except ValueError as exc:raise ValueError(f'การ์ดสำรอง: {exc}') from exc
    return normalized,fallback

def preview_calendar_mapping(data):
    if not isinstance(data,dict):raise ValueError('ข้อมูลไม่ถูกต้อง')
    title=str(data.get('title','')).strip()
    if not title or len(title)>200:raise ValueError('กรอกชื่อประชุมไม่เกิน 200 ตัวอักษร')
    rules,fallback=normalize_calendar_rules(data,settings()['baseUrl'])
    rule=match_rule(title,rules)
    return {'rule':rule['name'] if rule else 'การ์ดสำรอง','issue':rule['issue'] if rule else fallback}

def save_calendar_rules(data):
    if not isinstance(data,dict):raise ValueError('ข้อมูลไม่ถูกต้อง')
    current=settings()
    if not current['baseUrl'] or not current['email'] or not current['token']:
        raise ValueError('บันทึกการเชื่อมต่อ Jira ก่อนตั้งค่าการ์ด')
    rules,fallback=normalize_calendar_rules(data,current['baseUrl'])
    issues=[]
    for issue in dict.fromkeys([*(rule['issue'] for rule in rules),fallback]):
        try:result=api('GET',f'/rest/api/3/issue/{parse.quote(issue)}?fields=summary,issuetype')
        except Exception as exc:raise ValueError(f'{issue}: ตรวจการ์ดใน Jira ไม่สำเร็จ · {exc}') from exc
        require_loggable(issue,result)
        issues.append({'key':issue,'summary':(result.get('fields') or {}).get('summary') or ''})
    write_settings({**current,'calendarRules':rules,'calendarFallback':fallback})
    return {'calendarRules':rules,'calendarFallback':fallback,'issues':issues}

def save_settings(data):
    if not isinstance(data,dict):raise ValueError('ข้อมูลตั้งค่าไม่ถูกต้อง')
    current=settings()
    base=str(data.get('baseUrl','')).strip().rstrip('/')
    email=str(data.get('email','')).strip()
    token=str(data.get('token','')).strip() or current['token']
    timezone=str(data.get('timezone','')).strip()
    board_ids=parse_board_ids(data.get('boardIds',[]),required=False)
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+\.atlassian\.net',base):
        raise ValueError('Jira site URL ต้องเป็น https://your-org.atlassian.net')
    if not email or len(email)>254 or '@' not in email:raise ValueError('กรอกอีเมล Jira ให้ถูกต้อง')
    if not token or len(token)>1000:raise ValueError('กรอก Jira API token')
    if not timezone or len(timezone)>80:raise ValueError('กรอก timezone ให้ถูกต้อง')
    try:ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:raise ValueError('ไม่พบ timezone นี้ เช่น Asia/Bangkok') from exc
    values={'baseUrl':base,'email':email,'token':token,'timezone':timezone,'boardIds':board_ids,
            'calendarRules':current['calendarRules'],'calendarFallback':current['calendarFallback']}
    write_settings(values)
    return public_settings()

def timezone():
    return ZoneInfo(settings()['timezone'])

def parse_bot_holidays(payload,year):
    rows=payload.get('holidayCalendarLists') if isinstance(payload,dict) else None
    if not isinstance(rows,list) or not rows:raise ValueError(f'BOT ไม่มีข้อมูลวันหยุดปี {year}')
    holidays={}
    for row in rows:
        if not isinstance(row,dict) or str(row.get('year'))!=str(year+543):
            raise ValueError(f'ข้อมูลวันหยุด BOT ปี {year} ไม่ถูกต้อง')
        month=BOT_MONTHS.get(str(row.get('month','')).strip())
        match=re.search(r'(\d{1,2})\s*$',str(row.get('date','')))
        name=str(row.get('holidayDescription','')).strip()
        if not month or not match or not name:raise ValueError(f'ข้อมูลวันหยุด BOT ปี {year} ไม่ครบ')
        day=date(year,month,int(match.group(1))).isoformat()
        holidays[day]=' / '.join(filter(None,[holidays.get(day),name]))
    return holidays

def bot_holidays(year,force=False):
    if not 2021<=year<=2100:raise ValueError('เลือกปี BOT ระหว่าง 2021–2100')
    with BOT_LOCK:
        cache=json.loads(BOT_CACHE.read_text(encoding='utf8')) if BOT_CACHE.exists() else {}
        previous=cache.get(str(year))
        if previous and not force and time.time()-previous.get('fetchedAt',0)<86400:
            return previous['holidays'],{'year':year,'syncedAt':previous['fetchedAt'],'stale':False}
        try:
            req=request.Request(BOT_MODEL.format(year+543),headers={'Accept':'application/json','User-Agent':'WorklogStudio/1.0'})
            with request.urlopen(req,timeout=15) as response:
                raw=response.read(1_000_001)
                if len(raw)>1_000_000:raise ValueError('ข้อมูลวันหยุด BOT ใหญ่เกินไป')
            holidays=parse_bot_holidays(json.loads(raw),year)
        except Exception as exc:
            if previous:
                return previous['holidays'],{'year':year,'syncedAt':previous['fetchedAt'],'stale':True}
            raise ValueError(f'ซิงก์วันหยุด BOT ปี {year} ไม่สำเร็จ: {exc}') from exc
        updated={'holidays':holidays,'fetchedAt':time.time()}
        cache[str(year)]=updated
        temp_path=None
        try:
            with tempfile.NamedTemporaryFile('w',encoding='utf8',dir=BOT_CACHE.parent,prefix='.bot-holidays-',suffix='.tmp',delete=False) as temp:
                temp_path=Path(temp.name)
                json.dump(cache,temp,ensure_ascii=False)
                temp.flush();os.fsync(temp.fileno())
            os.replace(temp_path,BOT_CACHE)
        finally:
            if temp_path and temp_path.exists():temp_path.unlink()
        return holidays,{'year':year,'syncedAt':updated['fetchedAt'],'stale':False}

def holidays_for_period(start_day,end_day,force=False):
    holidays={};sources=[]
    if end_day<=start_day:return holidays,sources
    for year in range(start_day.year,(end_day-timedelta(days=1)).year+1):
        yearly,source=bot_holidays(year,force)
        holidays.update(yearly)
        sources.append(source)
    return holidays,sources

class JiraError(Exception):
    def __init__(self, status, detail):
        self.status=status
        super().__init__(f'Jira HTTP {status}: {str(detail)[:350]}')

def api(method, path, data=None):
    current=settings()
    base=current['baseUrl'].rstrip('/')
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+\.atlassian\.net', base):
        raise ValueError('ตั้งค่า Jira site URL ในหน้า ตั้งค่า Jira')
    email=current['email']; key=current['token']
    if not email or not key: raise ValueError('ตั้งค่าอีเมลและ API token ในหน้า ตั้งค่า Jira')
    auth=base64.b64encode(f'{email}:{key}'.encode()).decode()
    body=json.dumps(data).encode() if data is not None else None
    req=request.Request(base+path,method=method,data=body,headers={
      'Authorization':'Basic '+auth,'Accept':'application/json',
      'Content-Type':'application/json','User-Agent':'local-board-worklog/2.0'})
    try:
        with request.urlopen(req,timeout=30) as response:
            raw=response.read(4_000_000)
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        raw=exc.read(2000).decode(errors='replace')
        raise JiraError(exc.code,raw) from None
    except error.URLError as exc:
        raise ValueError(f'Network failure: {exc.reason}') from None

def get_board(board_id):
    return api('GET',f'/rest/agile/1.0/board/{board_id}')

def get_issues(board_id):
    # The classic pagination contract for board issue endpoint uses startAt/total.
    results=[]; start=0; max_pages=40
    for _ in range(max_pages):
        query=parse.urlencode({'startAt':start,'maxResults':100,'fields':'summary,status,assignee,issuetype'})
        page=api('GET',f'/rest/agile/1.0/board/{board_id}/issue?{query}')
        issues=page.get('issues',[])
        if not isinstance(issues,list): raise ValueError('Unexpected Jira pagination response')
        for issue in issues:
            fields=issue.get('fields') or {}
            results.append({'key':issue.get('key'),'summary':fields.get('summary') or '',
               'status':(fields.get('status') or {}).get('name') or '',
               'type':(fields.get('issuetype') or {}).get('name') or '',
               'assignee':(fields.get('assignee') or {}).get('displayName') or 'Unassigned'})
        start += len(issues)
        if not issues or page.get('isLast') is True or start >= page.get('total',float('inf')):
            return results
    raise ValueError('Board has more than 4,000 issues; narrow the board filter before proceeding')

def get_boards_and_issues(board_ids):
    boards=[];merged={};failed=[]
    for board_id in board_ids:
        try:
            board=get_board(board_id)
            board_issues=get_issues(board_id)
        except JiraError as exc:
            if exc.status not in (403,404):raise
            failed.append({'id':board_id,'reason':'ไม่พบบอร์ดหรือบัญชีไม่มีสิทธิ์ดู'})
            continue
        name=board.get('name') or f'Board {board_id}'
        label=f'{name} (#{board_id})'
        boards.append({'id':board_id,'name':name,'type':board.get('type'),'issueCount':len(board_issues)})
        for issue in board_issues:
            key=issue['key']
            if key in merged:
                if label not in merged[key]['boards']:merged[key]['boards'].append(label)
            else:
                merged[key]={**issue,'boards':[label]}
    if not boards:raise ValueError(f'โหลดบอร์ดไม่ได้: {", ".join(board_ids)} · ตรวจ Board ID และสิทธิ์ของบัญชี Jira')
    return boards,list(merged.values()),failed

def period_worklogs(start_day,end_day):
    if end_day<=start_day:return []
    local_timezone=timezone()
    account_id=api('GET','/rest/api/3/myself').get('accountId')
    if not account_id:raise ValueError('Jira ไม่ส่ง accountId ของผู้ใช้')
    jql=(f'worklogDate >= "{start_day-timedelta(days=1)}" '
         f'AND worklogDate < "{end_day+timedelta(days=1)}" AND worklogAuthor = currentUser()')
    issues={};next_token=None
    for _ in range(100):
        params={'jql':jql,'fields':'summary','maxResults':100}
        if next_token:params['nextPageToken']=next_token
        page=api('GET','/rest/api/3/search/jql?'+parse.urlencode(params))
        for issue in page.get('issues',[]):
            issues[issue['key']]=(issue.get('fields') or {}).get('summary') or ''
        next_token=page.get('nextPageToken')
        if not next_token:break
    else:raise ValueError('พบงานมากกว่า 10,000 รายการในช่วงที่เลือก')
    entries=[]
    start_ms=int(datetime.combine(start_day,dt_time.min,local_timezone).timestamp()*1000)-1
    end_ms=int(datetime.combine(end_day,dt_time.min,local_timezone).timestamp()*1000)
    for issue_key,summary in issues.items():
        start_at=0
        for _ in range(100):
            query=parse.urlencode({'startAt':start_at,'maxResults':100,'startedAfter':start_ms,'startedBefore':end_ms})
            page=api('GET',f'/rest/api/3/issue/{parse.quote(issue_key)}/worklog?{query}')
            worklogs=page.get('worklogs',[])
            if not isinstance(worklogs,list):raise ValueError('Jira ส่งข้อมูล worklog ไม่ถูกต้อง')
            for worklog in worklogs:
                if (worklog.get('author') or {}).get('accountId')!=account_id:continue
                started=parse_jira_time(worklog['started']).astimezone(local_timezone)
                if not start_day<=started.date()<end_day:continue
                seconds=int(worklog.get('timeSpentSeconds') or 0)
                entries.append({'issue':issue_key,'summary':summary,'seconds':seconds,
                                'started':started.isoformat(),'date':started.date().isoformat()})
            start_at+=len(worklogs)
            if start_at>=page.get('total',0):break
            if not worklogs:raise ValueError('Jira ส่งหน้า worklog ว่างก่อนครบจำนวน')
        else:raise ValueError(f'{issue_key} มี worklog มากเกินขีดจำกัดสำหรับรายงานนี้')
    return entries

def weekly_worklogs(selected_date):
    week_start=selected_date-timedelta(days=selected_date.weekday())
    week_end=week_start+timedelta(days=7)
    local_timezone=timezone()
    today=datetime.now(local_timezone).date()
    try:
        holidays,sources=holidays_for_period(week_start,week_end)
        holiday_warning=None
    except ValueError as exc:
        holidays={};sources=[];holiday_warning=str(exc)
    days=[]
    for offset in range(5):
        day_date=week_start+timedelta(days=offset)
        holiday=holidays.get(day_date.isoformat())
        days.append({'date':day_date.isoformat(),'seconds':0,'targetSeconds':0 if holiday else 28800,
                     'holidayName':holiday,'entries':[]})
    weekend_seconds=0
    for entry in period_worklogs(week_start,week_end):
        day_index=(date.fromisoformat(entry['date'])-week_start).days
        if day_index>=5:weekend_seconds+=entry['seconds']
        else:
            day=days[day_index]
            day['seconds']+=entry['seconds']
            day['entries'].append({key:entry[key] for key in ('issue','summary','seconds','started')})
    for day in days:
        day['entries'].sort(key=lambda entry:(entry['started'],entry['issue']))
        day_date=date.fromisoformat(day['date'])
        day['status']='holiday' if day['holidayName'] else 'complete' if day['seconds']>=day['targetSeconds'] else 'upcoming' if day_date>today else 'today' if day_date==today else 'short'
    return {'weekStart':week_start.isoformat(),'weekEnd':(week_end-timedelta(days=1)).isoformat(),
            'today':today.isoformat(),'timezone':str(local_timezone),'days':days,
            'totalSeconds':sum(day['seconds'] for day in days),'targetSeconds':sum(day['targetSeconds'] for day in days),
            'weekendSeconds':weekend_seconds,'botSource':BOT_SOURCE,'botYears':sources,
            'holidayWarning':holiday_warning}

def worklog_alerts(year,force=False,weeks=0):
    today=datetime.now(timezone()).date()
    if not 2021<=year<=today.year:raise ValueError('เลือกปีตั้งแต่ 2021 ถึงปีปัจจุบัน')
    if weeks not in (0,4,12):raise ValueError('เลือกช่วงตรวจ 4 สัปดาห์, 12 สัปดาห์ หรือทั้งปี')
    year_start=date(year,1,1)
    end_day=min(today,date(year+1,1,1))
    last_day=end_day-timedelta(days=1)
    last_monday=last_day-timedelta(days=last_day.weekday())
    start_day=max(year_start,last_monday-timedelta(weeks=weeks-1)) if weeks else year_start
    holidays,sources=holidays_for_period(year_start,date(year+1,1,1),force)
    totals={}
    for entry in period_worklogs(start_day,end_day):
        totals[entry['date']]=totals.get(entry['date'],0)+entry['seconds']
    weeks={};checked=0
    current=start_day
    while current<end_day:
        if current.weekday()<5 and current.isoformat() not in holidays:
            checked+=1
            seconds=totals.get(current.isoformat(),0)
            if seconds<28800:
                monday=current-timedelta(days=current.weekday())
                week=weeks.setdefault(monday.isoformat(),{'weekStart':monday.isoformat(),
                    'weekEnd':(monday+timedelta(days=6)).isoformat(),'days':[],'missingSeconds':0})
                deficit=28800-seconds
                week['days'].append({'date':current.isoformat(),'seconds':seconds,'missingSeconds':deficit,
                                     'status':'empty' if seconds==0 else 'short'})
                week['missingSeconds']+=deficit
        current+=timedelta(days=1)
    alerts=sorted(weeks.values(),key=lambda week:week['weekStart'],reverse=True)
    return {'year':year,'today':today.isoformat(),'rangeStart':start_day.isoformat(),
            'rangeEnd':(end_day-timedelta(days=1)).isoformat(),'weeks':alerts,'workdaysChecked':checked,
            'missingDays':sum(len(week['days']) for week in alerts),
            'missingSeconds':sum(week['missingSeconds'] for week in alerts),
            'holidayCount':sum(start_day<=date.fromisoformat(day)<end_day for day in holidays),
            'botSource':BOT_SOURCE,'botYears':sources}

def run_calendar(command, start=None, end=None, calendar_ids=None):
    if command not in ('status','authorize','calendars','events'):
        raise ValueError('คำสั่ง Calendar ไม่ถูกต้อง')
    with CALENDAR_BUILD_LOCK:
        sources=[ROOT/'mac_calendar.swift',ROOT/'mac_calendar-Info.plist']
        if not CALENDAR_HELPER.exists() or any(source.stat().st_mtime>CALENDAR_HELPER.stat().st_mtime for source in sources):
            compiler=shutil.which('swiftc')
            if not compiler:raise ValueError('ไม่พบ Swift compiler บน Mac เครื่องนี้')
            CALENDAR_HELPER.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(sources[1],CALENDAR_APP/'Contents'/'Info.plist')
            environment={**os.environ,'CLANG_MODULE_CACHE_PATH':'/private/tmp/jira-clang-cache',
                         'SWIFT_MODULE_CACHE_PATH':'/private/tmp/jira-swift-cache'}
            result=subprocess.run([compiler,'-parse-as-library','-O','-Xlinker','-sectcreate',
                                   '-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',
                                   str(sources[1]),str(sources[0]),'-o',str(CALENDAR_HELPER)],
                                  capture_output=True,text=True,timeout=120,env=environment)
            if result.returncode:raise ValueError('คอมไพล์ตัวอ่าน Mac Calendar ไม่สำเร็จ: '+result.stderr[:350])
            signer=shutil.which('codesign')
            if not signer:raise ValueError('ไม่พบ codesign บน Mac เครื่องนี้')
            signed=subprocess.run([signer,'--force','--deep','--sign','-','--identifier',
                                   'local.worklogstudio.calendarreader',str(CALENDAR_APP)],
                                  capture_output=True,text=True,timeout=30)
            if signed.returncode:
                CALENDAR_HELPER.unlink(missing_ok=True)
                raise ValueError('เซ็นตัวอ่าน Mac Calendar ไม่สำเร็จ: '+signed.stderr[:350])
    with CALENDAR_RUN_LOCK:
        for attempt in range(3):
            with tempfile.TemporaryDirectory(prefix='worklog-calendar-') as output_dir:
                output=Path(output_dir)
                arguments=['open','-W','-n','--stdout',str(output/'stdout'),
                           '--stderr',str(output/'stderr'),'-a',str(CALENDAR_APP),'--args',command]
                if command=='events':
                    arguments.extend([start,end,','.join(calendar_ids)])
                try:
                    result=subprocess.run(arguments,capture_output=True,text=True,timeout=90 if command=='authorize' else 25)
                except subprocess.TimeoutExpired as exc:
                    raise ValueError('Mac Calendar ไม่ตอบสนอง กรุณาลองใหม่') from exc
                message=(output/'stderr').read_text(encoding='utf8') if (output/'stderr').exists() else ''
                response=(output/'stdout').read_text(encoding='utf8') if (output/'stdout').exists() else ''
                if result.returncode or not response:
                    detail=message or result.stderr or 'อ่าน Mac Calendar ไม่สำเร็จ'
                    if 'Unable to block on applications' in detail and attempt<2:
                        time.sleep(0.4*(attempt+1))
                        continue
                    raise ValueError(detail[:350])
                return json.loads(response)

def calendar_week(selected_date, calendar_ids):
    available={item['id'] for item in run_calendar('calendars')['calendars']}
    if not calendar_ids or len(calendar_ids)>10 or len(calendar_ids)!=len(set(calendar_ids)) or not set(calendar_ids)<=available:
        raise ValueError('เลือกปฏิทินที่ต้องการอ่านจากรายการก่อน')
    week_start=selected_date-timedelta(days=selected_date.weekday())
    week_end=week_start+timedelta(days=7)
    holidays,sources=holidays_for_period(week_start,week_end)
    holiday_dates={day for day in holidays if week_start.isoformat()<=day<week_end.isoformat()}
    local_timezone=timezone()
    start=datetime.combine(week_start,dt_time.min,local_timezone).isoformat()
    end=datetime.combine(week_end,dt_time.min,local_timezone).isoformat()
    events=run_calendar('events',start,end,calendar_ids)['events']
    current=settings()
    proposals=propose_events(events,week_start,str(local_timezone),current['calendarRules'],current['calendarFallback'])
    available_proposals=[proposal for proposal in proposals if proposal['date'] not in holiday_dates]
    return {'weekStart':week_start.isoformat(),'weekEnd':(week_end-timedelta(days=1)).isoformat(),
            'proposals':available_proposals,'holidayDates':sorted(holiday_dates),
            'excludedHolidayCount':len(proposals)-len(available_proposals),
            'botYears':sources}

def validate_calendar_entry(row,proposals,holiday_dates):
    if not isinstance(row,dict):raise ValueError('ข้อมูลรายการ Calendar ไม่ถูกต้อง')
    proposal=proposals.get(row.get('eventKey'))
    if not proposal:raise ValueError('รายการ Calendar เปลี่ยนไป กรุณาโหลดใหม่')
    issue=str(row.get('issue','')).strip().upper()
    current=settings()
    if issue not in {current['calendarFallback'],*(rule['issue'] for rule in current['calendarRules'])}:
        raise ValueError('เลือกได้เฉพาะการ์ดที่ตั้งค่าไว้ใน Calendar Mapping')
    day=date.fromisoformat(str(row.get('date','')))
    original_day=date.fromisoformat(proposal['date'])
    week_start=original_day-timedelta(days=original_day.weekday())
    if not week_start<=day<=week_start+timedelta(days=4):
        raise ValueError('วันที่ต้องอยู่ในวันทำงานของสัปดาห์เดียวกับการประชุม')
    if day.isoformat() in holiday_dates:raise ValueError('วันที่เลือกตรงกับวันหยุด BOT กรุณาเลือกวันทำงานอื่น')
    if day>datetime.now(timezone()).date():raise ValueError('ไม่ลงเวลาในอนาคต')
    minutes=row.get('minutes')
    if isinstance(minutes,bool) or not isinstance(minutes,int) or not 0<minutes<=1440:
        raise ValueError('นาทีต้องเป็นจำนวนเต็ม 1–1440')
    description=str(row.get('description','')).strip()
    if not description or len(description)>2000:raise ValueError('กรอกรายละเอียดงานไม่เกิน 2000 ตัวอักษร')
    started=(datetime.fromisoformat(proposal['start']) if day.isoformat()==proposal['date'] and not proposal['allDay']
             else datetime.combine(day,dt_time(9,0),timezone()))
    return {'eventKey':row['eventKey'],'issue':issue,'date':day.isoformat(),
            'seconds':minutes*60,'description':description,
            'started':started.strftime('%Y-%m-%dT%H:%M:%S.000%z')}

def submit_calendar_entries(payload):
    if not isinstance(payload,dict):raise ValueError('ข้อมูลไม่ถูกต้อง')
    selected_date=date.fromisoformat(str(payload.get('date','')))
    calendar_ids=payload.get('calendarIds')
    if not isinstance(calendar_ids,list) or not all(isinstance(item,str) for item in calendar_ids):
        raise ValueError('เลือกปฏิทินก่อน')
    items=payload.get('entries')
    if not isinstance(items,list) or not 0<len(items)<=100:raise ValueError('เลือก 1–100 รายการต่อครั้ง')
    with LOCK:
        current=calendar_week(selected_date,calendar_ids)
        proposals={row['eventKey']:row for row in current['proposals']}
        normal=[validate_calendar_entry(item,proposals,set(current['holidayDates'])) for item in items]
        event_keys=[row['eventKey'] for row in normal]
        if len(event_keys)!=len(set(event_keys)):raise ValueError('มีรายการ Calendar ซ้ำในชุดที่เลือก')
        for issue in set(row['issue'] for row in normal):
            require_loggable(issue,api('GET',f'/rest/api/3/issue/{issue}?fields=summary,issuetype'))
        return submit_rows(normal,'calendar')

def validate(row,allowed):
    key=str(row.get('issue','')).strip().upper()
    if not KEY_RE.fullmatch(key) or key not in allowed: raise ValueError(f'{key}: Issue is not in the selected board')
    if not loggable_type(allowed[key]):
        raise ValueError(f'{key}: ประเภท {allowed[key] or "ไม่ทราบ"} ลง worklog ไม่ได้ · ลงได้เฉพาะ Task และ Sub-task')
    day=date.fromisoformat(str(row.get('date','')))
    tz=timezone()
    if day>datetime.now(tz).date(): raise ValueError('Future worklog date is not allowed')
    hours=float(row.get('hours',0))
    seconds=round(hours*3600)
    if not 0<seconds<=86400 or abs(hours*3600-seconds)>0.001: raise ValueError('Hours must be > 0 and <= 24, in whole seconds')
    detail=str(row.get('description','')).strip()
    if not detail or len(detail)>2000: raise ValueError('Description required (max 2000 chars)')
    local=datetime.combine(day,dt_time(9,0),tz)
    return {'issue':key,'date':day.isoformat(),'seconds':seconds,'description':detail,
            'started':local.strftime('%Y-%m-%dT%H:%M:%S.000%z')}

def fingerprint(row):
    s=json.dumps(row,sort_keys=True,ensure_ascii=False)
    return hashlib.sha256(s.encode()).hexdigest()

def ledger():
    data={}
    if LEDGER.exists():
        for line in LEDGER.read_text(encoding='utf8').splitlines():
            if line.strip():
                entry=json.loads(line)
                data[entry['fingerprint']]=entry
    return data

def history():
    records=list(ledger().values())
    records.sort(key=lambda entry:entry.get('savedAt',''),reverse=True)
    return [{'issue':entry['issue'],'date':entry['date'],'id':entry.get('id'),
             'seconds':entry.get('seconds'),'source':entry.get('source','manual'),
             'status':entry.get('status','synced'),'savedAt':entry.get('savedAt'),
             'eventKey':entry.get('eventKey')} for entry in records]

def reconcile_history():
    with LOCK:
        uncertain=[entry for entry in ledger().values() if entry.get('status')=='uncertain']
        if not uncertain:return {'checked':0,'synced':0,'retryReady':0,'errors':[]}
        account_id=api('GET','/rest/api/3/myself').get('accountId')
        if not account_id:raise ValueError('Jira ไม่ส่ง accountId ของผู้ใช้')
        remote={};synced=0;retry_ready=0;errors=[]
        for entry in uncertain:
            if not entry.get('descriptionHash'):
                errors.append(f"{entry['issue']} {entry['date']}: ไม่มีรายละเอียดสำหรับตรวจซ้ำ")
                continue
            cache_key=(entry['issue'],entry['date'])
            try:
                if cache_key not in remote:remote[cache_key]=issue_worklogs(*cache_key)
                matched=matching_worklog(entry,remote[cache_key],account_id)
            except Exception as exc:
                errors.append(f"{entry['issue']} {entry['date']}: {exc}")
                continue
            next_status='synced' if matched else 'retry_ready'
            append_record({**entry,'id':matched,'status':next_status,
                           'savedAt':datetime.now(timezone()).isoformat()})
            if matched:synced+=1
            else:retry_ready+=1
        return {'checked':len(uncertain),'synced':synced,'retryReady':retry_ready,'errors':errors}

def comment_text(comment):
    if isinstance(comment,str):return comment.strip()
    if not isinstance(comment,dict):return ''
    if comment.get('type')=='text':return str(comment.get('text',''))
    return ''.join(comment_text(item) for item in comment.get('content',[])).strip()

def issue_worklogs(issue,day):
    local_timezone=timezone()
    start=int(datetime.combine(date.fromisoformat(day),dt_time.min,local_timezone).timestamp()*1000)-1
    end=int(datetime.combine(date.fromisoformat(day)+timedelta(days=1),dt_time.min,local_timezone).timestamp()*1000)
    worklogs=[];start_at=0
    for _ in range(100):
        query=parse.urlencode({'startAt':start_at,'maxResults':100,'startedAfter':start,'startedBefore':end})
        page=api('GET',f'/rest/api/3/issue/{parse.quote(issue)}/worklog?{query}')
        batch=page.get('worklogs',[])
        if not isinstance(batch,list):raise ValueError('Jira ส่งข้อมูล worklog ไม่ถูกต้อง')
        worklogs.extend(batch)
        start_at+=len(batch)
        if start_at>=page.get('total',0):return worklogs
        if not batch:raise ValueError('Jira ส่งหน้า worklog ว่างก่อนครบจำนวน')
    raise ValueError(f'{issue} มี worklog มากเกินขีดจำกัดสำหรับตรวจรายการซ้ำ')

def matching_worklog(row,worklogs,account_id):
    for item in worklogs:
        if (item.get('author') or {}).get('accountId')!=account_id:continue
        started=parse_jira_time(item['started']).astimezone(timezone())
        if started.date().isoformat()!=row['date']:continue
        if int(item.get('timeSpentSeconds') or 0)!=row['seconds']:continue
        description=comment_text(item.get('comment'))
        expected=row.get('description')
        if expected is not None and description!=expected:continue
        if expected is None and hashlib.sha256(description.encode()).hexdigest()!=row.get('descriptionHash'):continue
        return item.get('id')
    return None

def submit_rows(rows,source):
    known=ledger()
    known_events={entry['eventKey']:entry for entry in known.values() if entry.get('eventKey')}
    results=[];remote={};account_id=None
    for row in rows:
        record_key=fingerprint(row)
        previous=known_events.get(row.get('eventKey')) or known.get(record_key)
        if previous and previous.get('status')!='retry_ready':
            result='needs_review' if previous.get('status')=='uncertain' else 'skipped'
            results.append({'issue':row['issue'],'date':row['date'],'result':result,'id':previous.get('id')})
            if result=='needs_review':break
            continue
        if not account_id:
            account_id=api('GET','/rest/api/3/myself').get('accountId')
            if not account_id:raise ValueError('Jira ไม่ส่ง accountId ของผู้ใช้')
        cache_key=(row['issue'],row['date'])
        try:
            if cache_key not in remote:remote[cache_key]=issue_worklogs(*cache_key)
        except Exception as exc:
            results.append({'issue':row['issue'],'date':row['date'],'result':'check_failed','error':str(exc)})
            break
        existing_id=matching_worklog(row,remote[cache_key],account_id)
        if existing_id:
            record={'fingerprint':record_key,'eventKey':row.get('eventKey'),'id':existing_id,
                    'issue':row['issue'],'date':row['date'],'seconds':row['seconds'],
                    'source':'jira','status':'synced','savedAt':datetime.now(timezone()).isoformat()}
            append_record(record);known[record_key]=record
            if row.get('eventKey'):known_events[row['eventKey']]=record
            results.append({'issue':row['issue'],'date':row['date'],'result':'skipped','id':existing_id})
            continue
        body={'started':row['started'],'timeSpentSeconds':row['seconds'],'comment':adf(row['description'])}
        try:
            reply=api('POST',f"/rest/api/3/issue/{parse.quote(row['issue'])}/worklog?adjustEstimate=leave",body)
        except Exception as exc:
            record={'fingerprint':record_key,'eventKey':row.get('eventKey'),'issue':row['issue'],
                    'date':row['date'],'seconds':row['seconds'],
                    'descriptionHash':hashlib.sha256(row['description'].encode()).hexdigest(),'source':source,
                    'status':'uncertain','savedAt':datetime.now(timezone()).isoformat()}
            append_record(record)
            results.append({'issue':row['issue'],'date':row['date'],'result':'uncertain_or_failed','error':str(exc)})
            break
        record={'fingerprint':record_key,'eventKey':row.get('eventKey'),'id':reply.get('id'),
                'issue':row['issue'],'date':row['date'],'seconds':row['seconds'],
                'source':source,'status':'synced','savedAt':datetime.now(timezone()).isoformat()}
        append_record(record);known[record_key]=record
        if row.get('eventKey'):known_events[row['eventKey']]=record
        remote[cache_key].append({'id':reply.get('id'),'author':{'accountId':account_id},
                                  'started':row['started'],'timeSpentSeconds':row['seconds'],
                                  'comment':body['comment']})
        results.append({'issue':row['issue'],'date':row['date'],'result':'created','id':reply.get('id')})
        time.sleep(.2)
    return {'results':results,'stopped':len(results)<len(rows) or any(item['result'] in ('needs_review','check_failed','uncertain_or_failed') for item in results)}

def append_record(entry):
    descriptor=os.open(LEDGER,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    os.chmod(LEDGER,0o600)
    with os.fdopen(descriptor,'a',encoding='utf8') as f:
        f.write(json.dumps(entry,ensure_ascii=False)+'\n')
        f.flush(); os.fsync(f.fileno())

def adf(text):
    return {'type':'doc','version':1,'content':[{'type':'paragraph','content':[{'type':'text','text':text}]}]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,fmt,*args): pass
    def send(self,status,obj):
        raw=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Length',str(len(raw)))
        self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        try:
            if self.headers.get('Host')!='127.0.0.1:8765':return self.send(403,{'error':'Invalid host'})
            p=parse.urlsplit(self.path)
            if p.path=='/':
                raw=(ROOT/'index.html').read_bytes()
                self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
                self.send_header('Cache-Control','no-store');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
                self.end_headers();self.wfile.write(raw);return
            if p.path=='/app.js':
                raw=(ROOT/'app.js').read_bytes();self.send_response(200);self.send_header('Content-Type','application/javascript');self.end_headers();self.wfile.write(raw);return
            if p.path=='/calendar.js':
                raw=(ROOT/'calendar.js').read_bytes();self.send_response(200);self.send_header('Content-Type','application/javascript');self.end_headers();self.wfile.write(raw);return
            if p.path=='/styles.css':
                raw=(ROOT/'styles.css').read_bytes();self.send_response(200);self.send_header('Content-Type','text/css; charset=utf-8');self.end_headers();self.wfile.write(raw);return
            if p.path=='/api/config':return self.send(200,{'csrf':CSRF,**public_settings()})
            if p.path=='/api/history':return self.send(200,{'records':history()})
            if p.path=='/api/calendar/status':return self.send(200,run_calendar('status'))
            if p.path=='/api/calendar/calendars':return self.send(200,run_calendar('calendars'))
            if p.path=='/api/calendar/week':
                params=parse.parse_qs(p.query)
                week_value=params.get('date',[''])[0]
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',week_value):raise ValueError('เลือกวันที่ในสัปดาห์ให้ถูกต้อง')
                calendar_ids=params.get('ids',[''])[0].split(',')
                return self.send(200,calendar_week(date.fromisoformat(week_value),calendar_ids))
            if p.path=='/api/jira/me':
                account=api('GET','/rest/api/3/myself')
                return self.send(200,{'name':account.get('displayName') or account.get('emailAddress') or 'Jira user'})
            if p.path=='/api/worklogs/week':
                week_value=parse.parse_qs(p.query).get('date',[''])[0]
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',week_value):raise ValueError('เลือกวันที่ในสัปดาห์ให้ถูกต้อง')
                return self.send(200,weekly_worklogs(date.fromisoformat(week_value)))
            if p.path=='/api/worklogs/alerts':
                params=parse.parse_qs(p.query)
                year_value=params.get('year',[''])[0]
                if not re.fullmatch(r'\d{4}',year_value):raise ValueError('เลือกปี ค.ศ. 4 หลัก')
                weeks_value=params.get('weeks',['12'])[0]
                if weeks_value not in ('0','4','12'):raise ValueError('ช่วงตรวจไม่ถูกต้อง')
                return self.send(200,worklog_alerts(int(year_value),params.get('refresh',['0'])[0]=='1',int(weeks_value)))
            if p.path=='/api/board':
                id=parse.parse_qs(p.query).get('id',[''])[0]
                if not id.isdigit() or not 0<int(id)<1000000000: raise ValueError('Board ID must be numeric')
                board=get_board(id);issues=get_issues(id)
                return self.send(200,{'board':{'id':board.get('id'),'name':board.get('name'),'type':board.get('type')},'issues':issues})
            if p.path=='/api/boards':
                board_ids=parse_board_ids(parse.parse_qs(p.query).get('ids',[''])[0])
                with LOCK:boards,issues,failed=get_boards_and_issues(board_ids)
                return self.send(200,{'boards':boards,'issues':issues,'failedBoards':failed})
            self.send(404,{'error':'Not found'})
        except Exception as exc:self.send(getattr(exc,'status',400),{'error':str(exc)})
    def do_POST(self):
        if self.headers.get('Host')!='127.0.0.1:8765':return self.send(403,{'error':'Invalid host'})
        if self.path not in ('/api/submit','/api/settings','/api/settings/calendar-mappings',
                             '/api/settings/calendar-mappings/preview','/api/calendar/authorize',
                             '/api/calendar/submit','/api/history/reconcile'):
            return self.send(404,{'error':'Not found'})
        if self.headers.get('X-Worklog-CSRF')!=CSRF:return self.send(403,{'error':'Invalid session token'})
        if self.headers.get('Origin') not in (None,'http://127.0.0.1:8765'):
            return self.send(403,{'error':'Invalid origin'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<300000:return self.send(400,{'error':'Invalid request size'})
            payload=json.loads(self.rfile.read(length))
            if self.path=='/api/settings/calendar-mappings/preview':return self.send(200,preview_calendar_mapping(payload))
            if self.path=='/api/settings/calendar-mappings':
                with LOCK:result=save_calendar_rules(payload)
                return self.send(200,result)
            if self.path=='/api/history/reconcile':return self.send(200,reconcile_history())
            if self.path=='/api/calendar/authorize':return self.send(200,run_calendar('authorize'))
            if self.path=='/api/calendar/submit':return self.send(200,submit_calendar_entries(payload))
            if self.path=='/api/settings':
                with LOCK: result=save_settings(payload)
                return self.send(200,result)
            board_ids=parse_board_ids(payload.get('boardIds',payload.get('boardId','')))
            items=payload.get('entries')
            if not isinstance(items,list) or not 0<len(items)<=100:raise ValueError('Select 1–100 worklogs per submit')
            with LOCK:
                # Re-fetch to enforce board membership server-side.
                allowed={issue['key']:issue['type'] for board_id in board_ids for issue in get_issues(board_id)}
                normal=[validate(item,allowed) for item in items]
                fps=[fingerprint(x) for x in normal]
                if len(fps)!=len(set(fps)):raise ValueError('Duplicate entries in selection')
                return self.send(200,submit_rows(normal,'manual'))
        except Exception as exc:self.send(getattr(exc,'status',400),{'error':str(exc)})

def main(argv=None):
    parser=argparse.ArgumentParser(description='Run Worklog Studio on http://127.0.0.1:8765')
    parser.add_argument('--version',action='version',version=f'Worklog Studio {VERSION}')
    parser.parse_args(argv)
    prepare_storage()
    print('Jira Board Worklog: http://127.0.0.1:8765')
    print('Only binds to localhost. Ctrl+C to stop.')
    ThreadingHTTPServer(('127.0.0.1',8765),Handler).serve_forever()

if __name__=='__main__':main()
