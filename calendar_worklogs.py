"""Pure calendar-event classification and daily worklog proposals."""
import hashlib
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

DEFAULT_MAPPINGS={'leave':'KNP-46','ceremony':'KNP-49','alignment':'KNP-5','other':'KNP-50'}
DEFAULT_RULES=[
    {'name':'IT Delivery Alignment','terms':['IT Delivery Alignment'],'issue':'KNP-5','isLeave':False},
    {'name':'วันลา','terms':['ลา','annual leave','sick leave','personal leave','vacation','pto','day off','leave','out of office','ooo'],'issue':'KNP-46','isLeave':True},
    {'name':'Sprint Ceremony','terms':['stand-up','stand up','daily scrum','refinement','planning','planing','retrospective','retro'],'issue':'KNP-49','isLeave':False},
]

def legacy_rules(mappings):
    rules=[{**rule,'terms':rule['terms'].copy()} for rule in DEFAULT_RULES]
    for rule,category in zip(rules,('alignment','leave','ceremony')):
        rule['issue']=mappings.get(category,DEFAULT_MAPPINGS[category])
    return rules

def match_rule(title,rules):
    folded=title.casefold()
    for rule in rules:
        for term in rule['terms']:
            candidate=term.casefold()
            if candidate.isascii():
                expression=r'(?<![a-z0-9])'+re.escape(candidate)+r'(?![a-z0-9])'
                matched=re.search(expression,folded) is not None
            else:matched=candidate in folded
            if matched:return rule
    return None

def propose_events(events, selected_date, timezone_name, rules=None, fallback_issue='KNP-50'):
    rules=rules if rules is not None else legacy_rules(DEFAULT_MAPPINGS)
    local_timezone=ZoneInfo(timezone_name)
    week_start=selected_date-timedelta(days=selected_date.weekday())
    week_end=week_start+timedelta(days=7)
    proposals=[]
    for event in events:
        title=str(event.get('title') or '').strip()
        if not title or title.casefold() in ('private event','private appointment','busy','ส่วนตัว'):
            continue
        if event.get('canceled') or event.get('declined') or event.get('free'):
            continue
        start=datetime.fromisoformat(event['start'].replace('Z','+00:00')).astimezone(local_timezone)
        end=datetime.fromisoformat(event['end'].replace('Z','+00:00')).astimezone(local_timezone)
        if end<=start:continue
        rule=match_rule(title,rules)
        issue=rule['issue'] if rule else fallback_issue
        all_day=bool(event.get('allDay'))
        needs_category=all_day and not (rule and rule['isLeave'])
        if needs_category:issue=''
        first_day=max(start.date(),week_start)
        last_day=min((end-timedelta(microseconds=1)).date(),week_end-timedelta(days=1))
        current_day=first_day
        while current_day<=last_day:
            if current_day.weekday()<5:
                day_start=datetime.combine(current_day,time.min,local_timezone)
                day_end=datetime.combine(current_day+timedelta(days=1),time.min,local_timezone)
                segment_start=max(start,day_start)
                segment_end=min(end,day_end)
                minutes=480 if all_day else round((segment_end-segment_start).total_seconds()/60)
                if minutes>0:
                    identity=f"{event['calendarId']}|{event['id']}|{start.isoformat()}|{current_day.isoformat()}"
                    proposals.append({'eventKey':hashlib.sha256(identity.encode()).hexdigest(),
                                      'calendarId':event['calendarId'],'title':title,'issue':issue,
                                      'date':current_day.isoformat(),'minutes':minutes,
                                      'description':title[:2000],'allDay':all_day,
                                      'start':segment_start.isoformat(),'end':segment_end.isoformat(),
                                      'warning':('เหตุการณ์ทั้งวัน · เลือกการ์ดเองและตรวจว่าเป็นวันลาหรือประชุม'
                                                 if needs_category else
                                                 'ตรวจว่าเป็นการประชุมจริง' if not rule and not event.get('hasAttendees') else '')})
            current_day+=timedelta(days=1)
    proposals.sort(key=lambda row:(row['date'],row['start'],row['title']))
    for index,proposal in enumerate(proposals):
        for previous in proposals[:index]:
            if previous['date']!=proposal['date']:continue
            if previous['start']<proposal['end'] and proposal['start']<previous['end']:
                proposal['warning']='; '.join(filter(None,[proposal['warning'],'เวลาซ้อนกับรายการอื่น']))
                previous['warning']='; '.join(filter(None,[previous['warning'],'เวลาซ้อนกับรายการอื่น']))
    return proposals
