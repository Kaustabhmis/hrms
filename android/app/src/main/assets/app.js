/* ===========================================================================
   BISCS employee app
   ---------------------------------------------------------------------------
   Everything this app can see belongs to the person holding the phone. That is
   not enforced here -- it is enforced by row-level security in Postgres, which
   is why there is no company_id filter anywhere below and no way to ask for
   somebody else's row. If this code asked, it would get nothing back.

   The one thing it must get right on its own is the punch: a factory floor has
   no signal, so a punch is written down locally the instant the slider lands
   and sent when the network comes back, never lost in between.
   =========================================================================== */
'use strict';

/* ---------------------------------------------------------------- config -- */
var CFG = {
    url: 'https://oacuhjpzivscczjbfewj.supabase.co',
    key: 'sb_publishable_aJ1MgCcqLyUCufVwXYSnew_7VaYaVqQ'
};
try {
    var saved = JSON.parse(localStorage.getItem('biscs-app-cfg') || 'null');
    if (saved && saved.url && saved.key) CFG = saved;
} catch (e) { /* first run */ }

var SB = null, ME = null, STATE = {
    day: todayIso(), punches: [], holidays: {}, leave: [], requests: [],
    attendance: {}, balances: [], inbox: [], approver: false, month: monthOf(todayIso())
};

/* ------------------------------------------------------------- utilities -- */
function $(id) { return document.getElementById(id); }
function pad(n) { return String(n).padStart(2, '0'); }
function todayIso() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function monthOf(iso) { return iso.slice(0, 7); }
function nowTime() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function hhmm(t) { return t ? String(t).slice(0, 5) : ''; }
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
var MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function pretty(iso) {
    if (!iso) return '--';
    var p = String(iso).slice(0, 10).split('-');
    return p[2] + ' ' + MON[+p[1] - 1].slice(0, 3) + ' ' + p[0];
}
function dowOf(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }
function isWeekOff(iso) { var d = dowOf(iso); return d === 0 || d === 6; }
function daysBetween(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    var da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]), db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((db - da) / 86400000) + 1;
}
function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 3400);
}
function openSheet(html) {
    $('sheet-body').innerHTML = html;
    $('sheet-bg').classList.add('on');
    $('sheet').classList.add('on');
}
function closeSheet() {
    $('sheet-bg').classList.remove('on');
    $('sheet').classList.remove('on');
}

/* ------------------------------------------------------------------ auth -- */
function client() {
    if (SB) return SB;
    if (!window.supabase || !window.supabase.createClient)
        throw new Error('The app files did not load completely. Close it and open it again.');
    SB = window.supabase.createClient(CFG.url, CFG.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    return SB;
}
function gateError(msg) {
    var e = $('gate-err');
    e.innerHTML = msg || '';
    e.style.display = msg ? 'block' : 'none';
}
function signIn() {
    var email = String($('gm').value || '').trim().toLowerCase();
    var pass = String($('gp').value || '');
    if (!email || !pass) return gateError('Enter your email and your password.');
    var btn = $('gbtn');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    gateError('');
    client().auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
        if (r.error) throw r.error;
        return start();
    }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'Sign in';
        var m = String(err && err.message || err);
        if (/Invalid login/i.test(m)) m = 'That email and password do not match an account.';
        else if (/fetch|network|Failed to/i.test(m)) m = 'No connection. Check your internet and try again.';
        else if (/Email not confirmed/i.test(m)) m = 'Your account has not been confirmed yet. Ask your HR team.';
        gateError(esc(m));
    });
}
function signOut() {
    if (!confirm('Sign out of this phone?')) return;
    client().auth.signOut().then(function () { location.reload(); });
}

/* ------------------------------------------------------------ the person -- */
// Everything the app needs, fetched once. RLS has already narrowed each of
// these to this person (and, if they manage anybody, their team).
function start() {
    return loadMe().then(function () {
        $('gate').style.display = 'none';
        $('app').style.display = 'flex';
        renderTabs();
        go('home');
        flushQueue();
        return Promise.all([loadMonth(STATE.month), loadLeave(), loadRequests(), loadInbox()])
            .then(render);
    }).catch(function (err) {
        var btn = $('gbtn');
        btn.disabled = false; btn.textContent = 'Sign in';
        gateError(esc(String(err && err.message || err)));
    });
}

function loadMe() {
    var sb = client();
    return sb.from('app_users').select('id,email,name,role,company_id,employee_id,status')
        .limit(1).single().then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            if (!r.data) throw new Error('No account found for this login.');
            if (r.data.status !== 'Active') throw new Error('This account is ' + r.data.status.toLowerCase() + '.');
            if (r.data.role !== 'employee')
                throw new Error('This app is for employees. Managers and HR sign in here too, but ' +
                    'an HR or admin account should use the full system in a browser.');
            if (!r.data.employee_id)
                throw new Error('Your login is not linked to an employee record yet. Ask your HR team to link it.');
            ME = r.data;
            return sb.from('employees').select('*').eq('id', r.data.employee_id).single();
        }).then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            ME.emp = r.data;
            return sb.rpc('am_i_an_approver');
        }).then(function (r) {
            STATE.approver = !!(r && r.data);
            var first = (ME.emp.name || ME.name || '?').trim().charAt(0).toUpperCase();
            $('t-av').textContent = first;
            $('t-name').textContent = ME.emp.name || ME.name;
            $('t-sub').textContent = [ME.emp.code, ME.emp.designation].filter(Boolean).join(' · ');
        });
}
function explain(err) {
    var m = (err && err.message) || String(err);
    if (/JWT|not authenticated/i.test(m)) return 'Your session has expired. Sign in again.';
    if (/permission denied|row-level security/i.test(m)) return 'You are not allowed to see that.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection.';
    return m;
}

/* ------------------------------------------------------------------ data -- */
function loadMonth(ym) {
    var from = ym + '-01';
    var last = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
    var to = ym + '-' + pad(last);
    var sb = client();
    return Promise.all([
        sb.from('punch_log').select('punch_date,punch_time,direction,source')
          .gte('punch_date', from).lte('punch_date', to).order('punch_time'),
        sb.from('daily_attendance').select('work_date,in_time,out_time,hours,punches')
          .gte('work_date', from).lte('work_date', to),
        sb.from('holidays').select('holiday_date,name,kind').gte('holiday_date', from).lte('holiday_date', to),
        sb.from('leave_ledger').select('from_date,to_date,code,status')
          .in('status', ['Approved', 'Pending']).lte('from_date', to).gte('to_date', from)
    ]).then(function (res) {
        STATE.month = ym;
        STATE.monthPunches = (res[0].data || []);
        STATE.punches = STATE.monthPunches.filter(function (p) { return p.punch_date === STATE.day; });
        STATE.attendance = {};
        (res[1].data || []).forEach(function (a) { STATE.attendance[a.work_date] = a; });
        STATE.holidays = {};
        (res[2].data || []).forEach(function (h) { STATE.holidays[h.holiday_date] = h; });
        STATE.monthLeave = (res[3].data || []);
    });
}
function loadLeave() {
    var sb = client();
    return Promise.all([
        sb.from('leave_ledger').select('*').order('from_date', { ascending: false }).limit(40),
        sb.from('leave_types').select('code,name,annual_days,paid'),
        sb.from('leave_credits').select('code,days')
    ]).then(function (res) {
        STATE.leave = res[0].data || [];
        STATE.leaveTypes = res[1].data || [];
        // Balance = everything credited to this person, less every day approved
        // or still waiting. Pending counts: a day you have asked for is not a
        // day you can ask for twice.
        var credited = {}, used = {};
        (res[2].data || []).forEach(function (c) { credited[c.code] = (credited[c.code] || 0) + Number(c.days); });
        (STATE.leave || []).forEach(function (l) {
            if (l.status === 'Approved' || l.status === 'Pending')
                used[l.code] = (used[l.code] || 0) + Number(l.days);
        });
        STATE.balances = (STATE.leaveTypes || []).map(function (t) {
            return { code: t.code, name: t.name, paid: t.paid,
                     left: (credited[t.code] || 0) - (used[t.code] || 0),
                     credited: credited[t.code] || 0 };
        });
    });
}
function loadRequests() {
    return client().from('attendance_requests').select('*')
        .order('raised_on', { ascending: false }).limit(40)
        .then(function (r) { STATE.requests = r.data || []; });
}
function loadInbox() {
    if (!STATE.approver) { STATE.inbox = []; return Promise.resolve(); }
    var sb = client();
    return Promise.all([
        sb.from('leave_ledger').select('*').eq('status', 'Pending'),
        sb.from('attendance_requests').select('*').eq('status', 'Pending'),
        sb.from('employees').select('id,name,code')
    ]).then(function (res) {
        var names = {};
        (res[2].data || []).forEach(function (e) { names[e.id] = e; });
        var mine = function (row) { return row.employee_id !== ME.employee_id; };   // not my own
        var leave = (res[0].data || []).filter(mine).map(function (l) {
            return { kind: 'leave', id: l.id, who: names[l.employee_id] || {}, row: l,
                     title: (l.code || 'Leave') + ' · ' + Number(l.days) + ' day(s)',
                     when: pretty(l.from_date) + (l.to_date !== l.from_date ? ' – ' + pretty(l.to_date) : ''),
                     why: l.reason || '' };
        });
        var att = (res[1].data || []).filter(mine).map(function (a) {
            return { kind: 'att', id: a.id, who: names[a.employee_id] || {}, row: a,
                     title: reqLabel(a.kind) + (a.in_time || a.out_time
                         ? ' · ' + [hhmm(a.in_time), hhmm(a.out_time)].filter(Boolean).join(' – ') : ''),
                     when: pretty(a.from_date) + (a.to_date !== a.from_date ? ' – ' + pretty(a.to_date) : ''),
                     why: a.reason || '' };
        });
        STATE.inbox = leave.concat(att);
    }).catch(function () { STATE.inbox = []; });
}
function reqLabel(k) {
    return k === 'OD' ? 'On duty' : k === 'ForgotPunch' ? 'Forgotten punch' : 'Attendance fix';
}

/* ------------------------------------------------------- punching, offline -- */
// A punch is written down here first and sent second. The phone in a workshop
// loses signal constantly; a punch that only exists while the network is up is
// a punch that turns into an absence.
function queueKey() { return 'biscs-app-queue-' + (ME ? ME.employee_id : 'x'); }
function queue() {
    try { return JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch (e) { return []; }
}
function setQueue(q) {
    try { localStorage.setItem(queueKey(), JSON.stringify(q)); } catch (e) { /* storage full */ }
    showOffline();
}
function showOffline() {
    var n = queue().length;
    var el = $('offline');
    if (!navigator.onLine || n) {
        el.classList.add('on');
        el.textContent = !navigator.onLine
            ? 'Offline — ' + (n ? n + ' punch(es) saved, they will be sent when you are back.'
                                     : 'your punches will be saved until you are back.')
            : 'Sending ' + n + ' saved punch(es)…';
    } else { el.classList.remove('on'); }
}
function flushQueue() {
    var q = queue();
    if (!q.length || !navigator.onLine || !ME) { showOffline(); return Promise.resolve(); }
    showOffline();
    return client().from('punch_log').insert(q).then(function (r) {
        // A duplicate means it already arrived on an earlier attempt, which is
        // a success, not a failure -- the unique key exists exactly for this.
        if (r.error && !/duplicate key/i.test(r.error.message || '')) throw r.error;
        // Only what was sent is cleared. A punch made while this was in flight
        // is still in the queue and must not be dropped along with the rest.
        setQueue(queue().slice(q.length));
        return loadMonth(STATE.month).then(render);
    }).catch(function () { showOffline(); });
}
window.addEventListener('online', function () { flushQueue(); });
window.addEventListener('offline', showOffline);

function nextDirection() {
    var last = STATE.punches[STATE.punches.length - 1];
    return (last && last.direction === 'IN') ? 'OUT' : 'IN';
}
// Written down first, sent second, and in that order for a reason. Asking the
// phone where it is can take seconds -- a denied permission, a shed with no
// sky -- and a punch that only exists inside that wait is a punch lost if the
// person pockets the phone. So it goes into local storage the instant the
// slider lands; the network and the GPS catch up afterwards.
function punch(direction) {
    if (!ME) return;
    var t = nowTime();
    var row = {
        company_id: ME.company_id, employee_id: ME.employee_id,
        punch_date: todayIso(), punch_time: t, direction: direction,
        source: 'Phone', entered_by: ME.email, geo_status: 'off'
    };
    var q = queue();
    var at = q.length;
    q.push(row);
    setQueue(q);

    STATE.punches.push({ punch_date: row.punch_date, punch_time: t, direction: direction, source: 'Phone' });
    renderHome();
    toast(direction === 'IN' ? 'Clocked in at ' + hhmm(t) : 'Clocked out at ' + hhmm(t));

    withLocation(function (pos) {
        if (pos) {
            var cur = queue();
            if (cur[at] && cur[at].punch_time === t) {
                cur[at].lat = pos.coords.latitude; cur[at].lng = pos.coords.longitude;
                cur[at].accuracy = pos.coords.accuracy; cur[at].geo_status = 'captured';
                setQueue(cur);
            }
        }
        flushQueue();
    });
}
// Location is a courtesy, never a gate: a refused permission or a basement with
// no fix must not hold up somebody clocking in, so the wait is short and the
// punch goes without coordinates rather than late.
function withLocation(done, budgetMs) {
    if (!navigator.geolocation) return done(null);
    var settled = false;
    var finish = function (p) { if (!settled) { settled = true; done(p); } };
    try {
        navigator.geolocation.getCurrentPosition(finish, function () { finish(null); },
            { enableHighAccuracy: true, timeout: budgetMs || 2500, maximumAge: 120000 });
    } catch (e) { return finish(null); }
    setTimeout(function () { finish(null); }, (budgetMs || 2500) + 200);
}

/* ------------------------------------------------------------ the slider -- */
// Sliding, not tapping. A button in a pocket gets pressed by accident all day;
// a deliberate drag across the whole width does not.
function wireSlider(el) {
    var thumb = el.querySelector('.thumb'), fill = el.querySelector('.fill');
    var dragging = false, startX = 0, x = 0, max = 0;
    var reset = function () {
        el.classList.remove('dragging');
        thumb.style.left = '5px'; fill.style.width = '0px';
    };
    var begin = function (ev) {
        if (el.classList.contains('done')) return;
        dragging = true; max = el.clientWidth - 62;
        startX = (ev.touches ? ev.touches[0].clientX : ev.clientX);
        el.classList.add('dragging');
    };
    var move = function (ev) {
        if (!dragging) return;
        var cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
        x = Math.max(0, Math.min(max, cx - startX));
        thumb.style.left = (5 + x) + 'px';
        fill.style.width = (x + 57) + 'px';
        if (ev.cancelable) ev.preventDefault();
    };
    var end = function () {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        if (x > max * 0.82) { punch(el.dataset.dir); }
        else reset();
        x = 0;
    };
    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', begin);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
}

/* --------------------------------------------------------- the day's sums -- */
function worked(punches) {
    // Pairs of IN/OUT. An unmatched IN means still inside, counted up to now.
    var mins = 0, openAt = null;
    punches.slice().sort(function (a, b) { return a.punch_time.localeCompare(b.punch_time); })
        .forEach(function (p) {
            if (p.direction === 'IN') { if (openAt === null) openAt = p.punch_time; }
            else if (openAt !== null) { mins += minutesBetween(openAt, p.punch_time); openAt = null; }
        });
    var live = false;
    if (openAt !== null && punches.length && punches[0].punch_date === todayIso()) {
        mins += minutesBetween(openAt, nowTime()); live = true;
    }
    return { mins: mins, live: live, openAt: openAt };
}
function minutesBetween(a, b) {
    var pa = a.split(':'), pb = b.split(':');
    return Math.max(0, (pb[0] * 60 + +pb[1]) - (pa[0] * 60 + +pa[1]));
}
function hoursText(mins) {
    return Math.floor(mins / 60) + 'h ' + pad(mins % 60) + 'm';
}

/* ============================== SCREENS ================================== */
var TAB = 'home';
function renderTabs() {
    var tabs = [
        ['home', '\u{1F3E0}', 'Home'],
        ['cal',  '\u{1F5D3}', 'Calendar'],
        ['req',  '\u{1F4E8}', 'Requests']
    ];
    if (STATE.approver) tabs.push(['appr', '✅', 'Approvals']);
    tabs.push(['me', '\u{1F464}', 'Me']);
    $('tabs').innerHTML = tabs.map(function (t) {
        var n = (t[0] === 'appr' && STATE.inbox.length) ? '<span class="badge">' + STATE.inbox.length + '</span>' : '';
        return '<button class="tab' + (TAB === t[0] ? ' on' : '') + '" onclick="go(\'' + t[0] + '\')">' +
               '<span class="ic">' + t[1] + n + '</span>' + t[2] + '</button>';
    }).join('');
}
function go(tab) {
    TAB = tab;
    ['home', 'cal', 'req', 'appr', 'me'].forEach(function (t) {
        $('p-' + t).classList.toggle('on', t === tab);
    });
    $('scroll').scrollTop = 0;
    renderTabs();
    render();
}
function render() {
    if (TAB === 'home') renderHome();
    if (TAB === 'cal') renderCal();
    if (TAB === 'req') renderReq();
    if (TAB === 'appr') renderAppr();
    if (TAB === 'me') renderMe();
    renderTabs();
    showOffline();
}

/* ------------------------------------------------------------------ home -- */
function renderHome() {
    var p = STATE.punches, w = worked(p), dir = nextDirection();
    var hol = STATE.holidays[todayIso()];
    var onLeave = (STATE.monthLeave || []).find(function (l) {
        return l.status === 'Approved' && l.from_date <= todayIso() && l.to_date >= todayIso();
    });
    var state, cls = '';
    if (!p.length) state = { big: '--:--', lab: 'Not clocked in yet' };
    else if (w.live) state = { big: hoursText(w.mins), lab: 'Working since ' + hhmm(w.openAt) };
    else state = { big: hoursText(w.mins), lab: 'Clocked out at ' + hhmm(p[p.length - 1].punch_time) };

    var sliderHtml = '';
    if (hol) {
        sliderHtml = '<div class="slider done"><div class="txt">\u{1F389} ' + esc(hol.name) + ' — holiday</div>' +
            '<div class="thumb"></div><div class="fill"></div></div>' +
            '<div class="muted" style="text-align:center; margin-top:8px;">Working today? Clock in anyway ' +
            'and ask for a comp-off.</div>' +
            '<button class="btn ghost" style="margin-top:10px;" onclick="forcePunch()">Clock in anyway</button>';
    } else if (onLeave) {
        sliderHtml = '<div class="slider done"><div class="txt">\u{1F334} On leave today</div>' +
            '<div class="thumb"></div><div class="fill"></div></div>';
    } else {
        sliderHtml = '<div class="slider' + (dir === 'OUT' ? ' out' : '') + '" id="slider" data-dir="' + dir + '">' +
            '<div class="fill"></div>' +
            '<div class="txt">' + (dir === 'IN' ? 'Slide to clock in' : 'Slide to clock out') + '</div>' +
            '<div class="thumb">' + (dir === 'IN' ? '→' : '←') + '</div></div>';
    }

    $('p-home').innerHTML =
        '<div class="card status">' +
            '<div class="muted" style="font-size:0.8rem;">' + DOW[dowOf(todayIso())] + ', ' + pretty(todayIso()) + '</div>' +
            '<div class="big" style="margin-top:6px;">' + state.big + '</div>' +
            '<div class="lab">' + esc(state.lab) + '</div>' +
            sliderHtml +
        '</div>' +

        '<div class="sec">Today’s punches</div>' +
        '<div class="card">' + (p.length
            ? p.slice().sort(function (a, b) { return a.punch_time.localeCompare(b.punch_time); })
               .map(function (x) {
                    return '<div class="row"><span class="k">' +
                        (x.direction === 'IN' ? '\u{1F7E2} In' : '\u{1F534} Out') + '</span>' +
                        '<span class="v">' + hhmm(x.punch_time) +
                        ' <span class="muted" style="font-weight:400;">' + esc(x.source || '') + '</span></span></div>';
               }).join('')
            : '<div class="empty">Nothing yet today. Slide the bar above when you arrive.</div>') +
        '</div>' +

        '<div class="sec">Quick actions</div>' +
        '<div class="chips">' +
            '<button class="chip" onclick="formLeave()"><span class="ic">\u{1F334}</span>Apply leave</button>' +
            '<button class="chip" onclick="formOD()"><span class="ic">\u{1F697}</span>On duty</button>' +
            '<button class="chip" onclick="formForgot()"><span class="ic">⏰</span>Forgot punch</button>' +
        '</div>';

    var el = $('slider');
    if (el) wireSlider(el);
}
function forcePunch() { punch(nextDirection()); }

/* -------------------------------------------------------------- calendar -- */
function dayStatus(iso) {
    // A holiday next week, or leave already approved for it, is exactly what
    // somebody opens this calendar to see -- so those are decided before the
    // day is written off as "not here yet".
    var hol = STATE.holidays[iso];
    if (hol) return 'holiday';
    var lv = (STATE.monthLeave || []).find(function (l) {
        return l.status === 'Approved' && l.from_date <= iso && l.to_date >= iso;
    });
    if (lv) return 'leave';
    if (iso > todayIso()) return 'future';
    var att = STATE.attendance[iso];
    var punched = (STATE.monthPunches || []).some(function (p) { return p.punch_date === iso; });
    if (att || punched) {
        var first = att && att.in_time ? att.in_time
            : (STATE.monthPunches.filter(function (p) { return p.punch_date === iso; })
                .map(function (p) { return p.punch_time; }).sort()[0] || '');
        return (first && first > '09:30:00') ? 'late' : 'present';
    }
    if (isWeekOff(iso)) return 'weekoff';
    return 'absent';
}
function renderCal() {
    var ym = STATE.month, y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var days = new Date(y, m, 0).getDate(), lead = new Date(y, m - 1, 1).getDay();
    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<div class="d pad"></div>';
    var count = { present: 0, late: 0, absent: 0, leave: 0, holiday: 0, weekoff: 0 };
    for (var d = 1; d <= days; d++) {
        var iso = ym + '-' + pad(d), st = dayStatus(iso);
        if (count[st] !== undefined) count[st]++;
        cells += '<div class="d ' + st + (iso === todayIso() ? ' today' : '') + '" onclick="dayDetail(\'' + iso + '\')">' +
                 d + '</div>';
    }
    $('p-cal').innerHTML =
        '<div class="cal-head">' +
            '<button onclick="shiftMonth(-1)">‹</button>' +
            '<div style="font-weight:700;">' + MON[m - 1] + ' ' + y + '</div>' +
            '<button onclick="shiftMonth(1)">›</button>' +
        '</div>' +
        '<div class="card">' +
            '<div class="cal-dow">' + DOW.map(function (d) { return '<div>' + d + '</div>'; }).join('') + '</div>' +
            '<div class="cal">' + cells + '</div>' +
            '<div class="legend">' +
                '<span><i style="background:#dcfce7"></i>Present</span>' +
                '<span><i style="background:#ffedd5"></i>Late</span>' +
                '<span><i style="background:#fee2e2"></i>Absent</span>' +
                '<span><i style="background:#ede9fe"></i>Leave</span>' +
                '<span><i style="background:#fef3c7"></i>Holiday</span>' +
                '<span><i style="background:#f8fafc; border:1px solid #e2e8f0"></i>Week off</span>' +
            '</div>' +
        '</div>' +
        '<div class="sec">This month</div>' +
        '<div class="card">' +
            '<div class="row"><span class="k">Present</span><span class="v">' + (count.present + count.late) + ' day(s)</span></div>' +
            '<div class="row"><span class="k">Late arrivals</span><span class="v">' + count.late + '</span></div>' +
            '<div class="row"><span class="k">Absent</span><span class="v">' + count.absent + '</span></div>' +
            '<div class="row"><span class="k">On leave</span><span class="v">' + count.leave + '</span></div>' +
            '<div class="row"><span class="k">Holidays</span><span class="v">' + count.holiday + '</span></div>' +
        '</div>' +
        '<div class="muted" style="text-align:center; margin-top:10px;">Tap any day to see the punches.</div>';
}
function shiftMonth(by) {
    var y = +STATE.month.slice(0, 4), m = +STATE.month.slice(5, 7) + by;
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    var ym = y + '-' + pad(m);
    $('p-cal').innerHTML = '<div class="empty"><span class="spin" style="border-color:#cbd5e1; border-top-color:#2563eb;"></span></div>';
    loadMonth(ym).then(renderCal).catch(function (e) { toast(explain(e), true); });
}
function dayDetail(iso) {
    var st = dayStatus(iso);
    var ps = (STATE.monthPunches || []).filter(function (p) { return p.punch_date === iso; })
        .sort(function (a, b) { return a.punch_time.localeCompare(b.punch_time); });
    var hol = STATE.holidays[iso];
    var lv = (STATE.monthLeave || []).find(function (l) { return l.from_date <= iso && l.to_date >= iso; });
    var label = { present: 'Present', late: 'Late arrival', absent: 'Absent', leave: 'On leave',
                  holiday: 'Holiday', weekoff: 'Week off', future: 'Still to come' }[st];
    var w = worked(ps);
    openSheet(
        '<h3>' + DOW[dowOf(iso)] + ', ' + pretty(iso) + '</h3>' +
        '<div class="muted" style="margin-bottom:14px;">' + label +
            (hol ? ' — ' + esc(hol.name) : '') +
            (lv ? ' — ' + esc(lv.code) + ' (' + esc(lv.status) + ')' : '') + '</div>' +
        (ps.length
            ? '<div class="card" style="margin:0 0 12px;">' + ps.map(function (p) {
                  return '<div class="row"><span class="k">' + (p.direction === 'IN' ? '\u{1F7E2} In' : '\u{1F534} Out') +
                         '</span><span class="v">' + hhmm(p.punch_time) + '</span></div>';
              }).join('') +
              '<div class="row"><span class="k">Time at work</span><span class="v">' + hoursText(w.mins) + '</span></div></div>'
            : '<div class="empty" style="padding:16px;">No punches on this day.</div>') +
        (st === 'absent' || (ps.length === 1)
            ? '<button class="btn" onclick="closeSheet(); formForgot(\'' + iso + '\')">Raise a forgotten punch</button>' +
              '<button class="btn ghost" style="margin-top:8px;" onclick="closeSheet(); formOD(\'' + iso + '\')">I was on duty outside</button>'
            : '')
    );
}

/* -------------------------------------------------------------- requests -- */
var REQ_TAB = 'leave';
function renderReq() {
    var tabs = [['leave', 'Leave'], ['od', 'On duty'], ['fp', 'Forgotten punch']];
    var bal = (STATE.balances || []).filter(function (b) { return b.credited > 0; });
    var list = '';
    if (REQ_TAB === 'leave') {
        list = (STATE.leave || []).length
            ? STATE.leave.map(function (l) {
                return card(
                    (l.code || 'Leave') + ' · ' + Number(l.days) + ' day(s)',
                    pretty(l.from_date) + (l.to_date !== l.from_date ? ' – ' + pretty(l.to_date) : ''),
                    l.reason, l.status,
                    l.status === 'Pending' ? 'withdrawLeave(\'' + l.id + '\')' : '');
              }).join('')
            : '<div class="empty">You have not asked for any leave yet.</div>';
    } else {
        var kind = REQ_TAB === 'od' ? 'OD' : 'ForgotPunch';
        var rows = (STATE.requests || []).filter(function (r) { return r.kind === kind; });
        list = rows.length
            ? rows.map(function (r) {
                return card(
                    reqLabel(r.kind) + (r.place ? ' · ' + r.place : '') +
                        ((r.in_time || r.out_time) ? ' · ' + [hhmm(r.in_time), hhmm(r.out_time)].filter(Boolean).join(' – ') : ''),
                    pretty(r.from_date) + (r.to_date !== r.from_date ? ' – ' + pretty(r.to_date) : ''),
                    r.reason, r.status,
                    r.status === 'Pending' ? 'withdrawReq(\'' + r.id + '\')' : '');
              }).join('')
            : '<div class="empty">Nothing here yet.</div>';
    }
    $('p-req').innerHTML =
        '<div style="display:flex; gap:6px; margin-bottom:14px;">' +
            tabs.map(function (t) {
                return '<button class="btn ' + (REQ_TAB === t[0] ? '' : 'ghost') + '" style="padding:9px 6px; font-size:0.78rem;" ' +
                       'onclick="REQ_TAB=\'' + t[0] + '\'; renderReq();">' + t[1] + '</button>';
            }).join('') +
        '</div>' +
        (REQ_TAB === 'leave' && bal.length
            ? '<div class="card"><h3>What you have left</h3>' + bal.map(function (b) {
                  return '<div class="row"><span class="k">' + esc(b.name) + '</span>' +
                         '<span class="v">' + (Math.round(b.left * 10) / 10) + ' day(s)</span></div>';
              }).join('') + '</div>'
            : '') +
        '<button class="btn" onclick="' +
            (REQ_TAB === 'leave' ? 'formLeave()' : REQ_TAB === 'od' ? 'formOD()' : 'formForgot()') +
        '">+ ' + (REQ_TAB === 'leave' ? 'Apply for leave' : REQ_TAB === 'od' ? 'Claim a day on duty' : 'Report a forgotten punch') + '</button>' +
        '<div class="sec">Your requests</div>' + list;
}
function card(title, when, why, status, undo) {
    var cls = status === 'Approved' ? 'p-ok' : status === 'Rejected' ? 'p-bad'
            : status === 'Withdrawn' ? 'p-grey' : 'p-warn';
    return '<div class="card">' +
        '<div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">' +
            '<div><div style="font-weight:700; font-size:0.92rem;">' + esc(title) + '</div>' +
            '<div class="muted">' + esc(when) + '</div></div>' +
            '<span class="pill ' + cls + '">' + esc(status) + '</span></div>' +
        (why ? '<div class="muted" style="margin-top:8px;">' + esc(why) + '</div>' : '') +
        (undo ? '<button class="btn ghost sm" style="margin-top:10px;" onclick="' + undo + '">Take it back</button>' : '') +
        '</div>';
}

function formLeave() {
    var opts = (STATE.leaveTypes || []).map(function (t) {
        var b = (STATE.balances || []).find(function (x) { return x.code === t.code; });
        return '<option value="' + esc(t.code) + '">' + esc(t.name) +
               (b ? ' (' + (Math.round(b.left * 10) / 10) + ' left)' : '') + '</option>';
    }).join('');
    openSheet('<h3>Apply for leave</h3>' +
        '<div class="muted">It goes to your manager for approval.</div>' +
        '<label class="f">Type of leave</label><select class="f" id="f-code">' +
            (opts || '<option value="CL">Casual Leave</option>') + '</select>' +
        '<label class="f">From</label><input class="f" type="date" id="f-from" value="' + todayIso() + '">' +
        '<label class="f">To</label><input class="f" type="date" id="f-to" value="' + todayIso() + '">' +
        '<label class="f">Why</label><textarea class="f" id="f-why" placeholder="A line is enough"></textarea>' +
        '<button class="btn" style="margin-top:16px;" id="f-go" onclick="submitLeave()">Send for approval</button>');
}
function submitLeave() {
    var code = $('f-code').value, from = $('f-from').value, to = $('f-to').value,
        why = String($('f-why').value || '').trim();
    if (!from || !to) return toast('Pick the dates.', true);
    if (to < from) return toast('The last day cannot be before the first.', true);
    if (!why) return toast('Say why, in a few words.', true);
    var days = daysBetween(from, to);
    var bal = (STATE.balances || []).find(function (b) { return b.code === code; });
    if (bal && bal.left < days &&
        !confirm('You have ' + (Math.round(bal.left * 10) / 10) + ' day(s) of that leave left and are asking for ' +
                 days + '.\n\nAnything over your balance is usually unpaid. Send it anyway?')) return;
    busy('f-go');
    client().from('leave_ledger').insert([{
        company_id: ME.company_id, employee_id: ME.employee_id, code: code,
        from_date: from, to_date: to, days: days, status: 'Pending',
        reason: why, applied_on: todayIso()
    }]).then(function (r) {
        if (r.error) throw r.error;
        closeSheet();
        toast('Sent to your manager.');
        return Promise.all([loadLeave(), loadMonth(STATE.month)]).then(render);
    }).catch(function (e) { unbusy('f-go', 'Send for approval'); toast(explain(e), true); });
}

function formOD(iso) {
    iso = iso || todayIso();
    openSheet('<h3>Claim a day on duty</h3>' +
        '<div class="muted">For a day you worked away from the office, so it is not counted as absent.</div>' +
        '<label class="f">From</label><input class="f" type="date" id="f-from" value="' + iso + '">' +
        '<label class="f">To</label><input class="f" type="date" id="f-to" value="' + iso + '">' +
        '<label class="f">Where were you</label><input class="f" type="text" id="f-place" placeholder="Client name or site">' +
        '<label class="f">What for</label><textarea class="f" id="f-why" placeholder="Site visit, delivery, meeting…"></textarea>' +
        '<button class="btn" style="margin-top:16px;" id="f-go" onclick="submitReq(\'OD\')">Send for approval</button>');
}
function formForgot(iso) {
    iso = iso || todayIso();
    openSheet('<h3>Report a forgotten punch</h3>' +
        '<div class="muted">For a day you were at work but the machine has no record of it.</div>' +
        '<label class="f">Which day</label><input class="f" type="date" id="f-from" value="' + iso + '">' +
        '<label class="f">Time you came in</label><input class="f" type="time" id="f-in">' +
        '<label class="f">Time you left</label><input class="f" type="time" id="f-out">' +
        '<div class="muted" style="margin-top:6px;">Fill in whichever one is missing. Both is fine too.</div>' +
        '<label class="f">What happened</label><textarea class="f" id="f-why" placeholder="Machine did not read my finger…"></textarea>' +
        '<button class="btn" style="margin-top:16px;" id="f-go" onclick="submitReq(\'ForgotPunch\')">Send for approval</button>');
}
function submitReq(kind) {
    var from = $('f-from').value, to = ($('f-to') || {}).value || from;
    var why = String($('f-why').value || '').trim();
    if (!from) return toast('Pick the day.', true);
    if (to < from) return toast('The last day cannot be before the first.', true);
    if (!why) return toast('Say what happened, in a few words.', true);
    var row = {
        company_id: ME.company_id, employee_id: ME.employee_id, kind: kind,
        from_date: from, to_date: to, reason: why, status: 'Pending'
    };
    if (kind === 'OD') row.place = String(($('f-place') || {}).value || '').trim() || null;
    if (kind === 'ForgotPunch') {
        row.in_time = ($('f-in') || {}).value || null;
        row.out_time = ($('f-out') || {}).value || null;
        if (!row.in_time && !row.out_time) return toast('Give at least one of the two times.', true);
    }
    busy('f-go');
    // No waiting on a GPS fix here. Where the phone was when somebody typed up
    // last Tuesday's missed punch proves nothing, and six seconds of a spinning
    // button to learn it is six seconds of somebody thinking it has hung.
    client().from('attendance_requests').insert([row]).then(function (r) {
        if (r.error) throw r.error;
        closeSheet();
        toast('Sent to your manager.');
        return loadRequests().then(render);
    }).catch(function (e) { unbusy('f-go', 'Send for approval'); toast(explain(e), true); });
}
function withdrawLeave(id) {
    if (!confirm('Take back this leave application?')) return;
    client().from('leave_ledger').delete().eq('id', id).then(function (r) {
        if (r.error) throw r.error;
        toast('Taken back.');
        return loadLeave().then(render);
    }).catch(function (e) { toast(explain(e), true); });
}
function withdrawReq(id) {
    if (!confirm('Take back this request?')) return;
    client().from('attendance_requests').delete().eq('id', id).then(function (r) {
        if (r.error) throw r.error;
        toast('Taken back.');
        return loadRequests().then(render);
    }).catch(function (e) { toast(explain(e), true); });
}
function busy(id) { var b = $(id); if (b) { b.disabled = true; b.innerHTML = '<span class="spin"></span>'; } }
function unbusy(id, t) { var b = $(id); if (b) { b.disabled = false; b.textContent = t; } }

/* ------------------------------------------------------------- approvals -- */
function renderAppr() {
    var inbox = STATE.inbox || [];
    $('p-appr').innerHTML =
        '<div class="sec">Waiting for you</div>' +
        (inbox.length ? inbox.map(function (it) {
            return '<div class="card">' +
                '<div style="font-weight:700;">' + esc(it.who.name || 'Team member') +
                    ' <span class="muted" style="font-weight:400;">' + esc(it.who.code || '') + '</span></div>' +
                '<div style="margin-top:4px; font-size:0.9rem;">' + esc(it.title) + '</div>' +
                '<div class="muted">' + esc(it.when) + '</div>' +
                (it.why ? '<div class="muted" style="margin-top:6px;">“' + esc(it.why) + '”</div>' : '') +
                '<div style="display:flex; gap:8px; margin-top:12px;">' +
                    '<button class="btn ok" onclick="decide(\'' + it.kind + '\',\'' + it.id + '\',\'Approved\')">Approve</button>' +
                    '<button class="btn bad" onclick="decide(\'' + it.kind + '\',\'' + it.id + '\',\'Rejected\')">Reject</button>' +
                '</div></div>';
        }).join('')
        : '<div class="empty">Nothing waiting. \u{1F389}</div>');
}
function decide(kind, id, status) {
    var note = '';
    if (status === 'Rejected') {
        note = prompt('Why are you rejecting it? They will see this.');
        if (note === null) return;
        if (!String(note).trim()) return toast('Give a reason — they will want to know.', true);
    }
    var sb = client(), who = (ME.emp && ME.emp.name) || ME.name;
    var p = (kind === 'leave')
        ? sb.from('leave_ledger').update({ status: status, action_by: who }).eq('id', id)
        : sb.from('attendance_requests').update({
              status: status, decided_by: who, decided_at: new Date().toISOString(),
              decision_note: note || null }).eq('id', id);
    p.then(function (r) {
        if (r.error) throw r.error;
        toast(status === 'Approved' ? 'Approved.' : 'Rejected.');
        return loadInbox().then(render);
    }).catch(function (e) { toast(explain(e), true); });
}

/* ---------------------------------------------------------------- profile -- */
function renderMe() {
    var e = ME.emp || {};
    var mask = function (v, keep) {
        if (!v) return '';
        v = String(v);
        return v.length <= keep ? v : v.slice(0, keep).replace(/./g, '•') + v.slice(keep);
    };
    var sec = function (title, rows) {
        var body = rows.filter(function (r) { return r[1]; }).map(function (r) {
            return '<div class="row"><span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span></div>';
        }).join('');
        return body ? '<div class="sec">' + title + '</div><div class="card">' + body + '</div>' : '';
    };
    $('p-me').innerHTML =
        '<div class="card" style="text-align:center;">' +
            '<div class="av" style="width:72px; height:72px; font-size:1.7rem; margin:4px auto 12px; ' +
                'background:var(--brand); color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center;">' +
                esc((e.name || '?').charAt(0).toUpperCase()) + '</div>' +
            '<div style="font-size:1.2rem; font-weight:800;">' + esc(e.name || '') + '</div>' +
            '<div class="muted">' + esc([e.designation, e.dept].filter(Boolean).join(' · ')) + '</div>' +
            '<div style="margin-top:8px;"><span class="pill p-info">' + esc(e.code || '') + '</span> ' +
                '<span class="pill p-grey">' + esc(e.status || '') + '</span></div>' +
        '</div>' +
        sec('Work', [
            ['Joined', e.doj ? pretty(e.doj) : ''],
            ['Employment', e.emp_type], ['Grade', e.grade],
            ['Location', e.location], ['Department', e.dept],
            ['Reports to', STATE.managerName || '']
        ]) +
        sec('Personal', [
            ['Date of birth', e.dob ? pretty(e.dob) : ''],
            ['Gender', e.gender], ['Father’s name', e.father_name],
            ['Email', e.email || ME.email]
        ]) +
        sec('Statutory', [
            ['PAN', mask(e.pan, 6)], ['UAN', mask(e.uan, 8)], ['ESIC number', mask(e.esic_no, 12)]
        ]) +
        sec('Bank', [['Account', mask(e.bank, Math.max(0, String(e.bank || '').length - 4))]]) +
        '<div class="muted" style="margin:14px 0; font-size:0.78rem; text-align:center;">' +
            'Something wrong here? Your HR team can correct it — these details come from your ' +
            'employee record and cannot be edited from the phone.</div>' +
        '<button class="btn ghost" onclick="signOut()">Sign out</button>' +
        '<div class="muted" style="text-align:center; margin-top:14px; font-size:0.72rem;">' +
            'BISCS OS · ' + esc(ME.email) + '</div>';
}

/* ------------------------------------------------------------------ boot -- */
$('gbtn').addEventListener('click', signIn);
$('gp').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
$('gm').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('gp').focus(); });

if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is a bonus, not a must */ });
    });
}

// An existing session means the person never sees the sign-in screen again,
// which for a shop-floor app matters more than it sounds.
(function () {
    try {
        client().auth.getSession().then(function (r) {
            if (r && r.data && r.data.session) start();
        }).catch(function () { /* show the gate */ });
    } catch (e) { gateError('The app files did not load completely. Close it and open it again.'); }
})();

// Keep the clock on the home screen honest while somebody is clocked in.
setInterval(function () { if (TAB === 'home' && ME && worked(STATE.punches).live) renderHome(); }, 30000);
