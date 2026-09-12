/* ==========================================================================
 * SUPABASE ADAPTER
 *
 * The module was written to run with no backend at all, and it still does.
 * This file is what it uses when there is one: the same three gates, but
 * decided by Postgres rather than by the page.
 *
 *   signed out            -> the sign-in gate, as before
 *   configured + signed in -> identity and tenant data come from Supabase
 *   not configured         -> everything falls back to localStorage
 *
 * Nothing here trusts the browser. Row-level security decides what a query
 * returns; if this adapter asked for another company's employees it would get
 * an empty list, not an error to catch and certainly not the rows.
 * ========================================================================== */
(function (global) {
    'use strict';

    var SB = null;                 // the supabase-js client, once created
    var cfg = { url: '', anonKey: '', enabled: false };
    var CONFIG_KEY = 'biscs-hrms-supabase-v1';

    function loadConfig() {
        try {
            var raw = localStorage.getItem(CONFIG_KEY);
            if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
        } catch (e) { /* storage unavailable; stay local */ }
        return cfg;
    }
    function saveConfig(next) {
        cfg = Object.assign(cfg, next || {});
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
        return cfg;
    }
    function isConfigured() { return !!(cfg.url && cfg.anonKey); }
    function isLive() { return !!(cfg.enabled && SB); }

    // supabase-js is fetched only when a backend is actually configured, so a
    // file:// copy with no network stays exactly as fast as it was.
    function loadLibrary() {
        if (global.supabase && global.supabase.createClient) return Promise.resolve(global.supabase);
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
            s.onload = function () {
                if (global.supabase && global.supabase.createClient) resolve(global.supabase);
                else reject(new Error('supabase-js loaded but did not register itself.'));
            };
            s.onerror = function () {
                reject(new Error('Could not fetch supabase-js. If this page is offline or the CDN is blocked, ' +
                    'download supabase.js next to this file and load it there instead.'));
            };
            document.head.appendChild(s);
        });
    }

    function connect() {
        if (!isConfigured()) return Promise.reject(new Error('Set the project URL and anon key first.'));
        return loadLibrary().then(function (lib) {
            SB = lib.createClient(cfg.url, cfg.anonKey, {
                auth: { persistSession: true, autoRefreshToken: true }
            });
            return SB;
        });
    }

    // --- health -----------------------------------------------------------
    function ping() {
        return connect().then(function (sb) {
            return sb.from('modules').select('key', { count: 'exact', head: true }).then(function (r) {
                if (r.error) throw new Error(explain(r.error));
                return { ok: true, modules: r.count };
            });
        });
    }
    function explain(err) {
        if (!err) return '';
        var m = err.message || String(err);
        if (/JWT|not authenticated|invalid claim/i.test(m)) return 'Not signed in, or the session has expired.';
        if (/permission denied|row-level security/i.test(m))
            return 'The database refused that. This is row-level security working: the account is not entitled to those rows.';
        if (/relation .* does not exist/i.test(m)) return 'That table is not in the database — has the migration been run?';
        if (/Failed to fetch|NetworkError/i.test(m)) return 'Could not reach the project. Check the URL, and that this page is allowed to call it.';
        return m;
    }

    // --- auth -------------------------------------------------------------
    function signIn(email, password) {
        return connect().then(function (sb) {
            return sb.auth.signInWithPassword({ email: email, password: password });
        }).then(function (r) {
            if (r.error) throw new Error(/Invalid login/i.test(r.error.message)
                ? 'That email and password do not match an account.' : explain(r.error));
            return fetchProfile();
        });
    }
    function signOut() { return SB ? SB.auth.signOut() : Promise.resolve(); }

    // Who the database says this session is. Never what the page thinks.
    function fetchProfile() {
        return SB.auth.getUser().then(function (u) {
            if (u.error || !u.data || !u.data.user) throw new Error('Not signed in.');
            return SB.from('app_users')
                .select('id,email,name,role,company_id,employee_id,all_modules,status')
                .eq('id', u.data.user.id).single();
        }).then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            if (r.data.status !== 'Active') throw new Error('This account is ' + r.data.status.toLowerCase() + '.');
            return r.data;
        });
    }

    // The entitlement list, resolved by the database rather than asserted here.
    function myModules() {
        return SB.rpc('my_modules').then(function (r) {
            if (!r.error) return r.data;
            // No RPC deployed: work it out from the two tables, which RLS has
            // already filtered to this account's company.
            return SB.from('company_modules').select('module_key').then(function (c) {
                if (c.error) throw new Error(explain(c.error));
                return (c.data || []).map(function (x) { return x.module_key; });
            });
        });
    }

    // --- data -------------------------------------------------------------
    // One place that turns a table into rows, so every caller gets the same
    // error handling and nobody writes .error checks by hand.
    function read(table, opts) {
        opts = opts || {};
        var q = SB.from(table).select(opts.columns || '*');
        Object.keys(opts.where || {}).forEach(function (k) { q = q.eq(k, opts.where[k]); });
        if (opts.order) q = q.order(opts.order, { ascending: opts.ascending !== false });
        if (opts.limit) q = q.limit(opts.limit);
        return q.then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            return r.data || [];
        });
    }
    function insert(table, rows) {
        return SB.from(table).insert(rows).select().then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            return r.data;
        });
    }
    function update(table, match, patch) {
        var q = SB.from(table).update(patch);
        Object.keys(match).forEach(function (k) { q = q.eq(k, match[k]); });
        return q.select().then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            return r.data;
        });
    }
    function remove(table, match) {
        var q = SB.from(table).delete();
        Object.keys(match).forEach(function (k) { q = q.eq(k, match[k]); });
        return q.then(function (r) {
            if (r.error) throw new Error(explain(r.error));
            return true;
        });
    }

    global.BiscsBackend = {
        loadConfig: loadConfig, saveConfig: saveConfig,
        isConfigured: isConfigured, isLive: isLive,
        connect: connect, ping: ping, explain: explain,
        signIn: signIn, signOut: signOut, profile: fetchProfile, myModules: myModules,
        read: read, insert: insert, update: update, remove: remove,
        client: function () { return SB; }
    };
})(window);
