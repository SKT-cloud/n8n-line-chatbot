export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // 0) AUTH (เหมือนเดิม)
    // =========================
    const auth = request.headers.get("Authorization");
    if (!auth || auth !== `Bearer ${env.API_KEY}`) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // =========================
    // Helpers: Time / Date (Asia/Bangkok)
    // =========================
    const TZ = "Asia/Bangkok";

    function todayISOInBangkok() {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());

      const y = parts.find((p) => p.type === "year").value;
      const m = parts.find((p) => p.type === "month").value;
      const d = parts.find((p) => p.type === "day").value;
      return `${y}-${m}-${d}`;
    }

    function nowHHMMInBangkok() {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date());
      const hh = parts.find((p) => p.type === "hour").value;
      const mm = parts.find((p) => p.type === "minute").value;
      return `${hh}:${mm}`;
    }

    function ymdToUTCNoon(ymd) {
      const [Y, M, D] = String(ymd).split("-").map(Number);
      return new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
    }

    function addDays(ymd, n) {
      const dt = ymdToUTCNoon(ymd);
      dt.setUTCDate(dt.getUTCDate() + n);
      return dt.toISOString().slice(0, 10);
    }

    function pad2(n) {
      return String(n).padStart(2, "0");
    }

    const TH_WEEKDAY = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"]; // JS getDay() 0..6
    const TH_MONTH_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

    function weekdayThaiFromYMD(ymd) {
      const dt = ymdToUTCNoon(ymd);
      // วันใน Bangkok == วัน UTC noon ของวันนั้น (ปลอดภัย)
      const jsDay = dt.getUTCDay(); // 0..6
      return TH_WEEKDAY[jsDay] || null;
    }

    function formatThaiDayTitle(weekdayThai, ymd) {
      // "วันศุกร์ (07 มี.ค.)"
      if (!ymd) return weekdayThai ? `วัน${weekdayThai}` : "ตารางเรียน";
      const dt = ymdToUTCNoon(ymd);
      const dd = pad2(dt.getUTCDate());
      const mm = dt.getUTCMonth(); // 0..11
      const mShort = TH_MONTH_SHORT[mm] || "";
      const wd = weekdayThai || weekdayThaiFromYMD(ymd) || "";
      return `วัน${wd} (${dd} ${mShort})`;
    }

    function norm(s) {
      return String(s ?? "").trim();
    }

    function isHHMM(s) {
      return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
    }

    function hhmmToMin(hhmm) {
      const [h, m] = String(hhmm).split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
      return h * 60 + m;
    }

    function inRange(now, start, end) {
      const n = hhmmToMin(now);
      const s = hhmmToMin(start);
      const e = hhmmToMin(end);
      if (![n, s, e].every(Number.isFinite)) return false;
      return n >= s && n < e;
    }

    const DAY_ORDER = ["จันทร์","อังคาร","พุธ","พฤหัสบดี","พฤหัส","ศุกร์","เสาร์","อาทิตย์"];
    const dayIndex = (d) => {
      const i = DAY_ORDER.indexOf(d);
      return i >= 0 ? i : 99;
    };

    async function resolveTerm(todayISO) {
      const row = await env.DB.prepare(
        `SELECT academic_year, term, start_date, end_date
         FROM academic_terms
         WHERE start_date <= ? AND end_date >= ?
         LIMIT 1`
      )
        .bind(todayISO, todayISO)
        .first();

      if (!row) return null;

      return {
        academic_year: row.academic_year,
        term: row.term,
        semester: `${row.term}/${row.academic_year}`,
        start_date: row.start_date,
        end_date: row.end_date,
      };
    }

    // =========================
    // 1) HEALTH
    // =========================
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // =========================
    // 2) TERM RESOLVE
    // GET /term/resolve
    // =========================
    if (url.pathname === "/term/resolve" && request.method === "GET") {
      const todayISO = todayISOInBangkok();
      const termInfo = await resolveTerm(todayISO);

      if (!termInfo) {
        return Response.json(
          { ok: false, error: "term not found for today", today: todayISO },
          { status: 404 }
        );
      }

      return Response.json({ ok: true, today: todayISO, ...termInfo });
    }

    // =========================================================
    // ✅ NEW: SCHEDULE QUERY (Generic endpoint)
    // POST /schedule/query
    //
    // Accept body:
    // {
    //   "user_id": "...",
    //   "intent": "schedule_all|schedule_day|schedule_week|schedule_next|schedule_current|schedule_first|schedule_last|schedule_day_endtime",
    //   "date": "YYYY-MM-DD" | null,
    //   "weekday": "จันทร์" | ... | null
    // }
    //
    // Return:
    // {
    //   ok, type:"schedule", mode:"all|day|week|single|status",
    //   date, today, semester,
    //   meta:{ title, altText, subtitle, target_weekday },
    //   data:[...],
    //   extra:{...}
    // }
    // =========================================================
    
    if (url.pathname === "/schedule/query" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      const user_id = norm(body?.user_id);
      const intent = norm(body?.intent) || "schedule_all";
      const reqDate = norm(body?.date) || null;
      const reqWeekday = norm(body?.weekday) || null;
      const modifier = norm(body?.modifier) || null; // e.g. "next_week" | null

      if (!user_id) {
        return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      }

      const todayISO = todayISOInBangkok();
      const termInfo = await resolveTerm(todayISO);
      if (!termInfo) {
        return Response.json(
          { ok: false, error: "term not found for today", today: todayISO },
          { status: 400 }
        );
      }

      // ---------- load all subjects in current term ----------
      let allRows = [];
      try {
        const res = await env.DB.prepare(
          `SELECT
             id, user_id, semester, day, subject_code, subject_name, section, type,
             room, start_time, end_time, instructor
           FROM subjects
           WHERE user_id = ? AND semester = ?
           ORDER BY
             CASE day
               WHEN 'จันทร์' THEN 1
               WHEN 'อังคาร' THEN 2
               WHEN 'พุธ' THEN 3
               WHEN 'พฤหัสบดี' THEN 4
               WHEN 'พฤหัส' THEN 4
               WHEN 'ศุกร์' THEN 5
               WHEN 'เสาร์' THEN 6
               WHEN 'อาทิตย์' THEN 7
               ELSE 99
             END,
             start_time ASC, end_time ASC, subject_code ASC`
        )
          .bind(user_id, termInfo.semester)
          .all();

        allRows = res?.results ?? [];
      } catch (e) {
        return Response.json(
          { ok: false, error: "DB query failed", detail: String(e) },
          { status: 500 }
        );
      }

      // ---------- helpers on rows ----------
      const isOnlineType = (it) => norm(it?.type).toLowerCase() === "online";

      function sortWithinDay(list) {
        // Online ไปท้ายสุด, แล้วเรียงเวลา
        return list.slice().sort((a, b) => {
          const ao = isOnlineType(a);
          const bo = isOnlineType(b);
          if (ao !== bo) return ao ? 1 : -1;
          return norm(a.start_time).localeCompare(norm(b.start_time));
        });
      }

      function rowsOfDay(dayThai) {
        const list = allRows.filter((r) => norm(r.day) === dayThai);
        return sortWithinDay(list);
      }

      // ---------- holiday helpers (match your table: holidays) ----------
      function dayStartISO(ymd) {
        // stored like 2026-02-24T00:00:00+07:00
        return `${ymd}T00:00:00+07:00`;
      }
      function dayEndISO(ymd) {
        return `${ymd}T23:59:59+07:00`;
      }

      async function getHolidayOverlayForDate(user_id, ymd) {
        const start = dayStartISO(ymd);
        const end = dayEndISO(ymd);

        // overlap rule: start_at <= endOfDay AND end_at >= startOfDay
        const res = await env.DB.prepare(
          `SELECT id, type, subject_id, all_day, start_at, end_at, title, note
           FROM holidays
           WHERE user_id = ?
             AND start_at <= ?
             AND end_at >= ?`
        ).bind(user_id, end, start).all();

        const list = res?.results ?? [];

        const fullDay = list.find((x) => norm(x.type) === "holiday" && Number(x.all_day) === 1) || null;
        const cancels = list.filter((x) => norm(x.type) === "cancel");

        return { fullDay, cancels, raw: list };
      }

      function matchCancel(row, cancel) {
        // cancel.subject_id may be subjects.id (integer) OR subject_code string like "CSI103"
        const sid = cancel?.subject_id;

        if (sid !== null && sid !== undefined && String(sid).trim() !== "") {
          const sidNum = Number(sid);
          if (Number.isFinite(sidNum) && Number.isFinite(Number(row?.id))) {
            if (Number(row.id) === sidNum) return true;
          }

          const sidStr = norm(String(sid)).toUpperCase();
          const code = norm(row?.subject_code).toUpperCase();
          if (sidStr && code && sidStr === code) return true;
        }

        return false;
      }

      function thaiRelativeLabel(targetDate) {
        if (!targetDate) return null;
        if (targetDate === todayISO) return "วันนี้";
        if (targetDate === addDays(todayISO, 1)) return "พรุ่งนี้";
        if (targetDate === addDays(todayISO, 2)) return "มะรืน";
        return null;
      }

      function makeHolidayMessage(targetDate, weekdayThai, titleOpt) {
        const rel = thaiRelativeLabel(targetDate);
        const dayLabel = formatThaiDayTitle(weekdayThai, targetDate); // "วันพุธ (25 ก.พ.)"
        const reason = titleOpt ? ` (${norm(titleOpt)})` : "";
        if (rel) return `${rel}เป็นวันหยุดค่ะ 😊${reason}`;
        return `${dayLabel} เป็นวันหยุดค่ะ 😊${reason}`;
      }

      // ---------- resolve target date ----------
      // Rules:
      // - schedule_day with weekday + no date + no modifier => "ทั้งเทอม" template view (no date resolve)
      // - otherwise:
      //   - if date provided => use it
      //   - else if weekday + modifier=next_week => weekday in next week
      //   - else if weekday => nearest day >= today that matches weekday
      //   - else => today
      function resolveSpecificDate() {
        let targetDate = reqDate || todayISO;
        let targetWeekday = reqWeekday || null;

        if (!reqDate && reqWeekday) {
          if (modifier === "next_week") {
            // monday of this week -> monday next week -> +weekday index
            const dt = ymdToUTCNoon(todayISO);
            const jsDay = dt.getUTCDay();       // 0..6
            const mondayBased = (jsDay + 6) % 7; // จันทร์=0
            const mondayThisWeek = addDays(todayISO, -mondayBased);
            const mondayNextWeek = addDays(mondayThisWeek, 7);

            const order = ["จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์","อาทิตย์"];
            const idx = order.indexOf(reqWeekday);
            targetDate = idx >= 0 ? addDays(mondayNextWeek, idx) : mondayNextWeek;
            targetWeekday = reqWeekday;
          } else {
            // nearest occurrence (including today)
            const maxLookahead = 14;
            let found = null;
            for (let i = 0; i <= maxLookahead; i++) {
              const d = addDays(todayISO, i);
              const wd = weekdayThaiFromYMD(d);
              if (wd === reqWeekday) {
                found = d;
                break;
              }
            }
            targetDate = found || todayISO;
            targetWeekday = reqWeekday;
          }
        }

        if (!targetWeekday) targetWeekday = weekdayThaiFromYMD(targetDate);
        return { targetDate, targetWeekday };
      }

      function metaForIntent(intent, weekdayThai, ymd, view) {
        const dayLabel = formatThaiDayTitle(weekdayThai, ymd);

        if (intent === "schedule_all") return { title: "ตารางเรียนทั้งหมด", altText: "ตารางเรียนทั้งหมด" };
        if (intent === "schedule_week") return { title: "ตารางเรียนสัปดาห์นี้", altText: "ตารางเรียนสัปดาห์นี้" };

        if (intent === "schedule_day" && view === "day_template") {
          return { title: `ตารางเรียนวัน${weekdayThai} (ทั้งเทอม)`, altText: `ตารางเรียนวัน${weekdayThai} (ทั้งเทอม)` };
        }
        if (intent === "schedule_day") return { title: `ตารางเรียน${dayLabel}`, altText: `ตารางเรียน${dayLabel}` };

        if (intent === "schedule_day_endtime") return { title: `เลิกกี่โมง • ${dayLabel}`, altText: `เลิกกี่โมง • ${dayLabel}` };
        if (intent === "schedule_first") return { title: `คาบแรก • ${dayLabel}`, altText: `คาบแรก • ${dayLabel}` };
        if (intent === "schedule_last") return { title: `คาบสุดท้าย • ${dayLabel}`, altText: `คาบสุดท้าย • ${dayLabel}` };
        if (intent === "schedule_next") return { title: `คาบต่อไป`, altText: `คาบต่อไป` };
        if (intent === "schedule_current") return { title: `ตอนนี้เรียนอะไร`, altText: `ตอนนี้เรียนอะไร` };

        return { title: "ตารางเรียน", altText: "ตารางเรียน" };
      }

      // ---------- base response ----------
      const base = {
        ok: true,
        type: "schedule",
        semester: termInfo.semester,
        today: todayISO,
        meta: {
          subtitle: `เทอม ${termInfo.semester} • วันนี้ ${todayISO}`,
        },
      };

      // ========== intent: schedule_all ==========
      if (intent === "schedule_all") {
        const m = metaForIntent(intent, null, null, "all");
        return Response.json({
          ...base,
          mode: "all",
          view: "all",
          date: null,
          meta: { ...base.meta, ...m, target_weekday: null },
          data: allRows,
        });
      }

      // ========== intent: schedule_week ==========
      if (intent === "schedule_week") {
        const { targetDate } = resolveSpecificDate();

        const dt = ymdToUTCNoon(targetDate);
        const jsDay = dt.getUTCDay(); // 0..6 (0=อาทิตย์)
        const mondayBased = (jsDay + 6) % 7; // จันทร์=>0, อาทิตย์=>6
        const weekStart = addDays(targetDate, -mondayBased);
        const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const weekDays = weekDates.map((d) => weekdayThaiFromYMD(d));
        const allowedDays = new Set(weekDays);
        const weekRows = allRows.filter((r) => allowedDays.has(norm(r.day)));

        const m = { title: "ตารางเรียนสัปดาห์นี้", altText: "ตารางเรียนสัปดาห์นี้" };
        return Response.json({
          ...base,
          mode: "week",
          view: "week",
          date: targetDate,
          week: { start: weekStart, dates: weekDates, days: weekDays },
          meta: { ...base.meta, ...m, target_weekday: null },
          data: weekRows,
        });
      }

      // ========== intent: schedule_day (template vs specific) ==========
      if (intent === "schedule_day") {
        // Template: "ตารางวันจันทร์" => ทั้งเทอม (no date resolve, no holiday overlay)
        if (reqWeekday && !reqDate && !modifier) {
          const list = rowsOfDay(reqWeekday);
          const m = metaForIntent(intent, reqWeekday, null, "day_template");
          return Response.json({
            ...base,
            mode: "day",
            view: "day_template",
            date: null,
            meta: { ...base.meta, ...m, target_weekday: reqWeekday },
            data: list,
          });
        }

        // Specific: resolve a real date (including "จันทร์หน้า")
        const { targetDate, targetWeekday } = resolveSpecificDate();

        // Holiday overlay
        try {
          const h = await getHolidayOverlayForDate(user_id, targetDate);

          // Full day holiday => status only, no schedule
          if (h.fullDay) {
            const m = metaForIntent(intent, targetWeekday, targetDate, "day_specific");
            return Response.json({
              ...base,
              mode: "status",
              view: "holiday_full_day",
              date: targetDate,
              meta: { ...base.meta, ...m, target_weekday: targetWeekday },
              holiday: { type: "holiday", title: norm(h.fullDay.title), note: norm(h.fullDay.note) },
              data: [],
              message: makeHolidayMessage(targetDate, targetWeekday, h.fullDay.title),
            });
          }

          const list = rowsOfDay(targetWeekday);
          const cancels = h.cancels || [];
          const withCancel = list.map((r) => {
            const canceled = cancels.some((c) => matchCancel(r, c));
            return canceled ? { ...r, _date: targetDate, _canceled: true } : { ...r, _date: targetDate, _canceled: false };
          });

          // If all canceled => behave like full day holiday (per your rule)
          const remaining = withCancel.filter((x) => !x._canceled);
          if (!remaining.length) {
            const m = metaForIntent(intent, targetWeekday, targetDate, "day_specific");
            return Response.json({
              ...base,
              mode: "status",
              view: "holiday_full_day",
              date: targetDate,
              meta: { ...base.meta, ...m, target_weekday: targetWeekday },
              holiday: { type: "cancel", title: "ยกคลาสทั้งวัน", note: "" },
              data: [],
              message: makeHolidayMessage(targetDate, targetWeekday, "ยกคลาสทั้งวัน"),
            });
          }

          const m = metaForIntent(intent, targetWeekday, targetDate, "day_specific");
          return Response.json({
            ...base,
            mode: "day",
            view: "day_specific",
            date: targetDate,
            meta: { ...base.meta, ...m, target_weekday: targetWeekday },
            holiday: cancels.length ? { type: "cancel", count: cancels.length } : null,
            data: withCancel,
          });
        } catch (e) {
          // Holiday table not available => fall back to normal schedule
          const list = rowsOfDay(targetWeekday).map((x) => ({ ...x, _date: targetDate, _canceled: false }));
          const m = metaForIntent(intent, targetWeekday, targetDate, "day_specific");
          return Response.json({
            ...base,
            mode: "day",
            view: "day_specific",
            date: targetDate,
            meta: { ...base.meta, ...m, target_weekday: targetWeekday },
            data: list,
            warn: "holiday overlay unavailable",
          });
        }
      }

      // ========== intent: schedule_day_endtime ==========
      if (intent === "schedule_day_endtime") {
        const { targetDate, targetWeekday } = resolveSpecificDate();

        try {
          const h = await getHolidayOverlayForDate(user_id, targetDate);

          if (h.fullDay) {
            const m = metaForIntent(intent, targetWeekday, targetDate, "status");
            return Response.json({
              ...base,
              mode: "status",
              view: "holiday_full_day",
              date: targetDate,
              meta: { ...base.meta, ...m, target_weekday: targetWeekday },
              holiday: { type: "holiday", title: norm(h.fullDay.title), note: norm(h.fullDay.note) },
              data: [],
              extra: { end_time: null },
              message: makeHolidayMessage(targetDate, targetWeekday, h.fullDay.title),
            });
          }

          const list = rowsOfDay(targetWeekday);
          const cancels = h.cancels || [];
          const withCancel = list.map((r) => {
            const canceled = cancels.some((c) => matchCancel(r, c));
            return canceled ? { ...r, _date: targetDate, _canceled: true } : { ...r, _date: targetDate, _canceled: false };
          });
          const remaining = withCancel.filter((x) => !x._canceled);

          if (!remaining.length) {
            const m = metaForIntent(intent, targetWeekday, targetDate, "status");
            return Response.json({
              ...base,
              mode: "status",
              view: "holiday_full_day",
              date: targetDate,
              meta: { ...base.meta, ...m, target_weekday: targetWeekday },
              holiday: { type: "cancel", title: "ยกคลาสทั้งวัน", note: "" },
              data: [],
              extra: { end_time: null },
              message: makeHolidayMessage(targetDate, targetWeekday, "ยกคลาสทั้งวัน"),
            });
          }

          const last = remaining[remaining.length - 1];
          const m = metaForIntent(intent, targetWeekday, targetDate, "status");
          return Response.json({
            ...base,
            mode: "status",
            view: "endtime",
            date: targetDate,
            meta: { ...base.meta, ...m, target_weekday: targetWeekday },
            data: [], // ✅ ไม่ส่งตารางตามที่เธอสั่ง
            extra: { end_time: norm(last.end_time) || null },
            message: `เลิกประมาณ ${norm(last.end_time)} นะคะ ✨`,
          });
        } catch (e) {
          const list = rowsOfDay(targetWeekday);
          if (!list.length) {
            const m = metaForIntent(intent, targetWeekday, targetDate, "status");
            return Response.json({
              ...base,
              mode: "status",
              view: "endtime",
              date: targetDate,
              meta: { ...base.meta, ...m, target_weekday: targetWeekday },
              data: [],
              extra: { end_time: null },
              message: `วันนั้นไม่มีเรียนค่ะ 😊`,
            });
          }
          const last = list[list.length - 1];
          const m = metaForIntent(intent, targetWeekday, targetDate, "status");
          return Response.json({
            ...base,
            mode: "status",
            view: "endtime",
            date: targetDate,
            meta: { ...base.meta, ...m, target_weekday: targetWeekday },
            data: [],
            extra: { end_time: norm(last.end_time) || null },
            message: `เลิกประมาณ ${norm(last.end_time)} นะคะ ✨`,
          });
        }
      }

      // ========== intent: schedule_first / schedule_last ==========
      if (intent === "schedule_first" || intent === "schedule_last") {
        const { targetDate, targetWeekday } = resolveSpecificDate();
        const list = rowsOfDay(targetWeekday);
        if (!list.length) {
          const m = metaForIntent(intent, targetWeekday, targetDate, "status");
          return Response.json({
            ...base,
            mode: "status",
            view: "status",
            date: targetDate,
            meta: { ...base.meta, ...m, target_weekday: targetWeekday },
            data: [],
            message: `วันนั้นไม่มีเรียนค่ะ 😊`,
          });
        }
        const picked = intent === "schedule_first" ? list[0] : list[list.length - 1];
        const m = metaForIntent(intent, targetWeekday, targetDate, "single");
        return Response.json({
          ...base,
          mode: "single",
          view: "single",
          date: targetDate,
          meta: { ...base.meta, ...m, target_weekday: targetWeekday },
          data: [{ ...picked, _date: targetDate, _canceled: false }],
        });
      }

      // ========== intent: schedule_current / schedule_next ==========
      // (ยังไม่ซ้อน holiday ใน current/next รอบนี้ เพื่อให้ patch เล็กและเสถียร)
      if (intent === "schedule_current" || intent === "schedule_next") {
        const now = nowHHMMInBangkok();

        const todayWd = weekdayThaiFromYMD(todayISO);
        const listToday = rowsOfDay(todayWd);

        if (intent === "schedule_current") {
          const cur = listToday.find((it) => isHHMM(it.start_time) && isHHMM(it.end_time) && inRange(now, it.start_time, it.end_time));
          if (cur) {
            const m = metaForIntent(intent, todayWd, todayISO, "single");
            return Response.json({
              ...base,
              date: todayISO,
              meta: { ...base.meta, ...m, target_weekday: todayWd },
              mode: "single",
              view: "single",
              data: [{ ...cur, _date: todayISO, _now: now, _canceled: false }],
              message: `ตอนนี้กำลังเรียนอยู่นะคะ ✨`,
            });
          }

          const nextInToday = listToday.find((it) => isHHMM(it.start_time) && hhmmToMin(it.start_time) > hhmmToMin(now));
          if (nextInToday) {
            const m = metaForIntent(intent, todayWd, todayISO, "status");
            return Response.json({
              ...base,
              date: todayISO,
              meta: { ...base.meta, ...m, target_weekday: todayWd },
              mode: "status",
              view: "status",
              data: [{ ...nextInToday, _date: todayISO, _now: now, _canceled: false }],
              message: `ตอนนี้ไม่มีคาบเรียนค่ะ 😊 คาบถัดไปเริ่ม ${norm(nextInToday.start_time)} นะคะ`,
            });
          }

          const m = metaForIntent(intent, todayWd, todayISO, "status");
          return Response.json({
            ...base,
            date: todayISO,
            meta: { ...base.meta, ...m, target_weekday: todayWd },
            mode: "status",
            view: "status",
            data: [],
            message: `ตอนนี้ไม่มีเรียนแล้วค่ะ 😊`,
          });
        }

        const nextInToday = listToday.find((it) => isHHMM(it.start_time) && hhmmToMin(it.start_time) > hhmmToMin(now));
        if (nextInToday) {
          const m = metaForIntent(intent, todayWd, todayISO, "single");
          return Response.json({
            ...base,
            date: todayISO,
            meta: { ...base.meta, ...m, target_weekday: todayWd },
            mode: "single",
            view: "single",
            data: [{ ...nextInToday, _date: todayISO, _now: now, _canceled: false }],
          });
        }

        const maxLookahead = 14;
        for (let i = 1; i <= maxLookahead; i++) {
          const d = addDays(todayISO, i);
          const wd = weekdayThaiFromYMD(d);
          const list = rowsOfDay(wd);
          if (list.length) {
            const m = metaForIntent(intent, wd, d, "single");
            return Response.json({
              ...base,
              date: d,
              meta: { ...base.meta, ...m, target_weekday: wd },
              mode: "single",
              view: "single",
              data: [{ ...list[0], _date: d, _canceled: false }],
              message: `คาบต่อไปคือ ${formatThaiDayTitle(wd, d)} นะคะ ✨`,
            });
          }
        }

        const m = metaForIntent(intent, todayWd, todayISO, "status");
        return Response.json({
          ...base,
          mode: "status",
          view: "status",
          date: todayISO,
          meta: { ...base.meta, ...m, target_weekday: todayWd },
          data: [],
          message: `ยังไม่พบคาบถัดไปในช่วงนี้ค่ะ 😊`,
        });
      }

      // fallback
      const { targetDate, targetWeekday } = resolveSpecificDate();
      const m = metaForIntent(intent, targetWeekday, targetDate, "status");
      return Response.json({
        ...base,
        ok: false,
        error: "unsupported intent",
        intent,
        mode: "status",
        view: "status",
        date: targetDate,
        meta: { ...base.meta, ...m, target_weekday: targetWeekday },
        data: [],
      });
    }
// =========================
    // 3) ADD SUBJECT (เดิม)
    // POST /subjects
    // =========================
    if (url.pathname === "/subjects" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      const required = [
        "user_id",
        "day",
        "subject_code",
        "subject_name",
        "section",
        "type",
        "room",
        "start_time",
        "end_time",
      ];

      const missing = required.filter((k) => !body?.[k] || String(body[k]).trim() === "");
      if (missing.length) {
        return Response.json({ ok: false, error: `missing: ${missing.join(", ")}` }, { status: 400 });
      }

      const todayISO = todayISOInBangkok();
      const termInfo = await resolveTerm(todayISO);

      if (!termInfo) {
        return Response.json({ ok: false, error: "term not found for today", today: todayISO }, { status: 400 });
      }

      const subject_code = String(body.subject_code).trim().toUpperCase();
      const section = String(body.section).replace(/\D/g, "").padStart(3, "0");
      const instructor = String(body.instructor ?? "").trim();

      const stmt = env.DB.prepare(
        `INSERT INTO subjects (
          user_id, semester, day, subject_code, subject_name, section, type, room,
          start_time, end_time, instructor
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        String(body.user_id).trim(),
        termInfo.semester,
        String(body.day).trim(),
        subject_code,
        String(body.subject_name).trim(),
        section,
        String(body.type).trim(),
        String(body.room).trim(),
        String(body.start_time).trim(),
        String(body.end_time).trim(),
        instructor
      );

      try {
        const res = await stmt.run();
        return Response.json({
          ok: true,
          inserted: true,
          semester: termInfo.semester,
          today: todayISO,
          meta: res?.meta ?? null,
        });
      } catch (e) {
        return Response.json({ ok: false, error: "DB insert failed", detail: String(e) }, { status: 500 });
      }
    }

    // =========================
    // 4) LIST SUBJECTS (เดิม)
    // GET /subjects/list?user_id=Uxxx
    // =========================
    if (url.pathname === "/subjects/list" && request.method === "GET") {
      const user_id = url.searchParams.get("user_id")?.trim();
      if (!user_id) return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });

      const todayISO = todayISOInBangkok();
      const termInfo = await resolveTerm(todayISO);
      if (!termInfo) return Response.json({ ok: false, error: "term not found for today", today: todayISO }, { status: 400 });

      try {
        const res = await env.DB.prepare(
          `SELECT
             id, user_id, semester, day, subject_code, subject_name, section, type,
             room, start_time, end_time, instructor
           FROM subjects
           WHERE user_id = ? AND semester = ?
           ORDER BY
             CASE day
               WHEN 'จันทร์' THEN 1
               WHEN 'อังคาร' THEN 2
               WHEN 'พุธ' THEN 3
               WHEN 'พฤหัสบดี' THEN 4
               WHEN 'พฤหัส' THEN 4
               WHEN 'ศุกร์' THEN 5
               WHEN 'เสาร์' THEN 6
               WHEN 'อาทิตย์' THEN 7
               ELSE 99
             END,
             start_time ASC, end_time ASC, subject_code ASC`
        )
          .bind(user_id, termInfo.semester)
          .all();

        return Response.json({ ok: true, semester: termInfo.semester, today: todayISO, data: res?.results ?? [] });
      } catch (e) {
        return Response.json({ ok: false, error: "DB query failed", detail: String(e) }, { status: 500 });
      }
    }

    // =========================
    // 5) GET ONE SUBJECT (เดิม)
    // GET /subjects/get?user_id=Uxxx&id=123
    // =========================
    if (url.pathname === "/subjects/get" && request.method === "GET") {
      const user_id = url.searchParams.get("user_id")?.trim();
      const id = Number(url.searchParams.get("id"));

      if (!user_id) return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      if (!Number.isFinite(id)) return Response.json({ ok: false, error: "missing/invalid id" }, { status: 400 });

      try {
        const row = await env.DB.prepare(
          `SELECT
             id, user_id, semester, day, subject_code, subject_name, section, type,
             room, start_time, end_time, instructor
           FROM subjects
           WHERE id = ? AND user_id = ?
           LIMIT 1`
        )
          .bind(id, user_id)
          .first();

        if (!row) return Response.json({ ok: false, error: "not found" }, { status: 404 });
        return Response.json({ ok: true, data: row });
      } catch (e) {
        return Response.json({ ok: false, error: "DB query failed", detail: String(e) }, { status: 500 });
      }
    }

    // =========================
    // 6) DELETE SUBJECT (เดิม)
    // POST /subjects/delete
    // =========================
    if (url.pathname === "/subjects/delete" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      const user_id = String(body?.user_id ?? "").trim();
      const id = Number(body?.id);

      if (!user_id) return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      if (!Number.isFinite(id)) return Response.json({ ok: false, error: "missing/invalid id" }, { status: 400 });

      try {
        const res = await env.DB.prepare(`DELETE FROM subjects WHERE id = ? AND user_id = ?`).bind(id, user_id).run();
        const changes = res?.meta?.changes ?? 0;
        return Response.json({ ok: true, deleted: changes > 0, changes });
      } catch (e) {
        return Response.json({ ok: false, error: "DB delete failed", detail: String(e) }, { status: 500 });
      }
    }

    // =========================
    // 7) UPDATE SUBJECT (เดิม)
    // POST /subjects/update
    // =========================
    if (url.pathname === "/subjects/update" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      const user_id = String(body?.user_id ?? "").trim();
      const id = Number(body?.id);

      if (!user_id) return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      if (!Number.isFinite(id)) return Response.json({ ok: false, error: "missing/invalid id" }, { status: 400 });

      const required = ["day","subject_code","subject_name","section","type","room","start_time","end_time"];
      const missing = required.filter((k) => !body?.[k] || String(body[k]).trim() === "");
      if (missing.length) return Response.json({ ok: false, error: `missing: ${missing.join(", ")}` }, { status: 400 });

      const subject_code = String(body.subject_code).trim().toUpperCase();
      const section = String(body.section).replace(/\D/g, "").padStart(3, "0");
      const instructor = String(body.instructor ?? "").trim();

      try {
        const res = await env.DB.prepare(
          `UPDATE subjects SET
             day = ?,
             subject_code = ?,
             subject_name = ?,
             section = ?,
             type = ?,
             room = ?,
             start_time = ?,
             end_time = ?,
             instructor = ?
           WHERE id = ? AND user_id = ?`
        )
          .bind(
            String(body.day).trim(),
            subject_code,
            String(body.subject_name).trim(),
            section,
            String(body.type).trim(),
            String(body.room).trim(),
            String(body.start_time).trim(),
            String(body.end_time).trim(),
            instructor,
            id,
            user_id
          )
          .run();

        const changes = res?.meta?.changes ?? 0;
        return Response.json({ ok: true, updated: changes > 0, changes });
      } catch (e) {
        return Response.json({ ok: false, error: "DB update failed", detail: String(e) }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};