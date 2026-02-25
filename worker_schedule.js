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

      // ---------- resolve target date ----------
      // Rules:
      // - if date provided => use it
      // - else if weekday provided => nearest day >= today that matches weekday
      // - else => today
      let targetDate = reqDate || todayISO;
      let targetWeekday = reqWeekday || null;

      if (!reqDate && reqWeekday) {
        // find next occurrence (including today)
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
        if (found) {
          targetDate = found;
          targetWeekday = reqWeekday;
        } else {
          targetDate = todayISO;
          targetWeekday = reqWeekday;
        }
      }

      // target weekday from resolved date
      if (!targetWeekday) targetWeekday = weekdayThaiFromYMD(targetDate);

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

      function clampTitleFromIntent() {
        // ตั้ง title/altText โดย Worker (Option B)
        // ใส่รูปแบบวันศุกร์ (07 มี.ค.) ให้ด้วย
        const dayLabel = formatThaiDayTitle(targetWeekday, targetDate);

        if (intent === "schedule_all") return { title: "ตารางเรียนทั้งหมด", altText: "ตารางเรียนทั้งหมด" };
        if (intent === "schedule_week") return { title: `ตารางเรียนสัปดาห์นี้`, altText: `ตารางเรียนสัปดาห์นี้` };
        if (intent === "schedule_day") return { title: `ตารางเรียน${dayLabel}`, altText: `ตารางเรียน${dayLabel}` };
        if (intent === "schedule_day_endtime") return { title: `เลิกกี่โมง • ${dayLabel}`, altText: `เลิกกี่โมง • ${dayLabel}` };
        if (intent === "schedule_first") return { title: `คาบแรก • ${dayLabel}`, altText: `คาบแรก • ${dayLabel}` };
        if (intent === "schedule_last") return { title: `คาบสุดท้าย • ${dayLabel}`, altText: `คาบสุดท้าย • ${dayLabel}` };
        if (intent === "schedule_next") return { title: `คาบต่อไป`, altText: `คาบต่อไป` };
        if (intent === "schedule_current") return { title: `ตอนนี้เรียนอะไร`, altText: `ตอนนี้เรียนอะไร` };
        return { title: "ตารางเรียน", altText: "ตารางเรียน" };
      }

      // ---------- build response per intent ----------
      const metaBase = clampTitleFromIntent();
      const base = {
        ok: true,
        type: "schedule",
        semester: termInfo.semester,
        today: todayISO,
        date: targetDate,
        meta: {
          ...metaBase,
          target_weekday: targetWeekday,
          // subtitle จะให้ flex โชว์บรรทัดรองได้
          subtitle: `เทอม ${termInfo.semester} • วันนี้ ${todayISO}`,
        },
      };

      // ========== intent: schedule_all ==========
      if (intent === "schedule_all") {
        return Response.json({
          ...base,
          mode: "all",
          data: allRows,
        });
      }

      // ========== intent: schedule_week ==========
      // default: สัปดาห์ที่มี targetDate (ถ้า NLU จะส่งแค่ "สัปดาห์หน้า" ก็ยังไงให้ handler ส่ง date = today+7 ได้)
      if (intent === "schedule_week") {
        // หา Monday ของสัปดาห์ (อิง จันทร์=1)
        const dt = ymdToUTCNoon(targetDate);
        const jsDay = dt.getUTCDay(); // 0..6 (0=อาทิตย์)
        // ต้องแปลงให้ monday-based: monday=0..6
        const mondayBased = (jsDay + 6) % 7; // จันทร์=>0, อาทิตย์=>6
        const weekStart = addDays(targetDate, -mondayBased);
        const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const weekDays = weekDates.map((d) => weekdayThaiFromYMD(d));

        // รวมเฉพาะวันที่อยู่ในสัปดาห์นี้ตาม day field
        const allowedDays = new Set(weekDays);
        const weekRows = allRows.filter((r) => allowedDays.has(norm(r.day)));

        return Response.json({
          ...base,
          mode: "week",
          week: { start: weekStart, dates: weekDates, days: weekDays },
          meta: {
            ...base.meta,
            title: `ตารางเรียนสัปดาห์นี้`,
            altText: `ตารางเรียนสัปดาห์นี้`,
          },
          data: weekRows,
        });
      }

      // ========== intent: schedule_day ==========
      if (intent === "schedule_day") {
        const list = rowsOfDay(targetWeekday);
        return Response.json({
          ...base,
          mode: "day",
          data: list.map((x) => ({ ...x, _date: targetDate })), // แปะ date ไว้ให้ flex ใช้ได้
        });
      }

      // ========== intent: schedule_day_endtime ==========
      if (intent === "schedule_day_endtime") {
        const list = rowsOfDay(targetWeekday);
        if (!list.length) {
          return Response.json({
            ...base,
            mode: "status",
            data: [],
            extra: { end_time: null },
            meta: {
              ...base.meta,
              title: `เลิกกี่โมง • ${formatThaiDayTitle(targetWeekday, targetDate)}`,
              altText: `เลิกกี่โมง • ${formatThaiDayTitle(targetWeekday, targetDate)}`,
            },
            message: `วันนี้ไม่มีเรียนค่ะ 😊`,
          });
        }
        const last = list[list.length - 1];
        return Response.json({
          ...base,
          mode: "status",
          data: list.map((x) => ({ ...x, _date: targetDate })),
          extra: { end_time: norm(last.end_time) || null },
          message: `เลิกประมาณ ${norm(last.end_time)} นะคะ ✨`,
        });
      }

      // ========== intent: schedule_first / schedule_last ==========
      if (intent === "schedule_first" || intent === "schedule_last") {
        const list = rowsOfDay(targetWeekday);
        if (!list.length) {
          return Response.json({
            ...base,
            mode: "status",
            data: [],
            message: `วันนี้ไม่มีเรียนค่ะ 😊`,
          });
        }
        const picked = intent === "schedule_first" ? list[0] : list[list.length - 1];
        return Response.json({
          ...base,
          mode: "single",
          data: [{ ...picked, _date: targetDate }],
        });
      }

      // ========== intent: schedule_current / schedule_next ==========
      if (intent === "schedule_current" || intent === "schedule_next") {
        const now = nowHHMMInBangkok();

        // สแกนวันนี้ก่อน
        const todayWd = weekdayThaiFromYMD(todayISO);
        const listToday = rowsOfDay(todayWd);

        if (intent === "schedule_current") {
          const cur = listToday.find((it) => isHHMM(it.start_time) && isHHMM(it.end_time) && inRange(now, it.start_time, it.end_time));
          if (cur) {
            return Response.json({
              ...base,
              date: todayISO,
              meta: {
                ...base.meta,
                title: `ตอนนี้เรียนอะไร`,
                altText: `ตอนนี้เรียนอะไร`,
                target_weekday: todayWd,
              },
              mode: "single",
              data: [{ ...cur, _date: todayISO, _now: now }],
              message: `ตอนนี้กำลังเรียนอยู่นะคะ ✨`,
            });
          }
          // ถ้าไม่เจอคาบที่กำลังเรียน → ตอบสถานะ + แนะนำคาบต่อไป
          const nextInToday = listToday.find((it) => isHHMM(it.start_time) && hhmmToMin(it.start_time) > hhmmToMin(now));
          if (nextInToday) {
            return Response.json({
              ...base,
              date: todayISO,
              meta: { ...base.meta, target_weekday: todayWd },
              mode: "status",
              data: [{ ...nextInToday, _date: todayISO, _now: now }],
              message: `ตอนนี้ไม่มีคาบเรียนค่ะ 😊 คาบถัดไปเริ่ม ${norm(nextInToday.start_time)} นะคะ`,
            });
          }
          return Response.json({
            ...base,
            date: todayISO,
            meta: { ...base.meta, target_weekday: todayWd },
            mode: "status",
            data: [],
            message: `ตอนนี้ไม่มีเรียนแล้วค่ะ 😊`,
          });
        }

        // schedule_next
        // ถ้าวันนี้ยังมีคาบถัดไป → เอาอันแรกที่ start_time > now
        const nextInToday = listToday.find((it) => isHHMM(it.start_time) && hhmmToMin(it.start_time) > hhmmToMin(now));
        if (nextInToday) {
          return Response.json({
            ...base,
            date: todayISO,
            meta: { ...base.meta, target_weekday: todayWd },
            mode: "single",
            data: [{ ...nextInToday, _date: todayISO, _now: now }],
          });
        }

        // ถ้าวันนี้ไม่มีแล้ว → หา “วันถัดไป” ที่มีเรียน (lookahead 14 วัน)
        const maxLookahead = 14;
        for (let i = 1; i <= maxLookahead; i++) {
          const d = addDays(todayISO, i);
          const wd = weekdayThaiFromYMD(d);
          const list = rowsOfDay(wd);
          if (list.length) {
            return Response.json({
              ...base,
              date: d,
              meta: {
                ...base.meta,
                title: `คาบต่อไป`,
                altText: `คาบต่อไป`,
                target_weekday: wd,
              },
              mode: "single",
              data: [{ ...list[0], _date: d }],
              message: `คาบต่อไปคือ ${formatThaiDayTitle(wd, d)} นะคะ ✨`,
            });
          }
        }

        return Response.json({
          ...base,
          mode: "status",
          data: [],
          message: `ยังไม่พบคาบถัดไปในช่วงนี้ค่ะ 😊`,
        });
      }

      // fallback
      return Response.json({
        ...base,
        ok: false,
        error: "unsupported intent",
        intent,
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