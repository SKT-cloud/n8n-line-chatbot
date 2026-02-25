export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --------------------
    // 0) AUTH (เหมือนของเดิม)
    // --------------------
    const auth = request.headers.get("Authorization");
    if (!auth || auth !== `Bearer ${env.API_KEY}`) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // --------------------
    // helper: today YYYY-MM-DD in Asia/Bangkok
    // --------------------
    function todayISOInBangkok() {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());

      const y = parts.find((p) => p.type === "year").value;
      const m = parts.find((p) => p.type === "month").value;
      const d = parts.find((p) => p.type === "day").value;
      return `${y}-${m}-${d}`;
    }

    // --------------------
    // helper: resolve current term from DB
    // --------------------
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

    // --------------------
    // 1) HEALTH
    // --------------------
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // --------------------
    // 2) TERM RESOLVE
    // GET /term/resolve
    // --------------------
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

    // --------------------
    // 3) ADD SUBJECT (Worker คำนวณ semester ให้เอง)
    // POST /subjects
    // --------------------
    if (url.pathname === "/subjects" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      // required (ไม่ต้องมี semester แล้ว)
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

      const missing = required.filter(
        (k) => !body?.[k] || String(body[k]).trim() === ""
      );

      if (missing.length) {
        return Response.json(
          { ok: false, error: `missing: ${missing.join(", ")}` },
          { status: 400 }
        );
      }

      const todayISO = todayISOInBangkok();
      const termInfo = await resolveTerm(todayISO);

      if (!termInfo) {
        return Response.json(
          { ok: false, error: "term not found for today", today: todayISO },
          { status: 400 }
        );
      }

      // normalize สำคัญ ๆ
      const subject_code = String(body.subject_code).trim().toUpperCase();
      const section = String(body.section).replace(/\D/g, "").padStart(3, "0");
      const instructor = String(body.instructor ?? "").trim();

      // insert (เพิ่ม user_id + semester)
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
        return Response.json(
          { ok: false, error: "DB insert failed", detail: String(e) },
          { status: 500 }
        );
      }
    }

    // --------------------
    // 4) LIST SUBJECTS (current term)
    // GET /subjects/list?user_id=Uxxx
    // --------------------
    if (url.pathname === "/subjects/list" && request.method === "GET") {
      const user_id = url.searchParams.get("user_id")?.trim();
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

        return Response.json({
          ok: true,
          semester: termInfo.semester,
          today: todayISO,
          data: res?.results ?? [],
        });
      } catch (e) {
        return Response.json(
          { ok: false, error: "DB query failed", detail: String(e) },
          { status: 500 }
        );
      }
    }

    // --------------------
    // 5) GET ONE SUBJECT (for confirm/edit)
    // GET /subjects/get?user_id=Uxxx&id=123
    // --------------------
    if (url.pathname === "/subjects/get" && request.method === "GET") {
      const user_id = url.searchParams.get("user_id")?.trim();
      const id = Number(url.searchParams.get("id"));

      if (!user_id) {
        return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      }
      if (!Number.isFinite(id)) {
        return Response.json({ ok: false, error: "missing/invalid id" }, { status: 400 });
      }

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

        if (!row) {
          return Response.json({ ok: false, error: "not found" }, { status: 404 });
        }

        return Response.json({ ok: true, data: row });
      } catch (e) {
        return Response.json(
          { ok: false, error: "DB query failed", detail: String(e) },
          { status: 500 }
        );
      }
    }

    // --------------------
    // 6) DELETE SUBJECT
    // POST /subjects/delete
    // body: { user_id, id }
    // --------------------
    if (url.pathname === "/subjects/delete" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      const user_id = String(body?.user_id ?? "").trim();
      const id = Number(body?.id);

      if (!user_id) {
        return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      }
      if (!Number.isFinite(id)) {
        return Response.json({ ok: false, error: "missing/invalid id" }, { status: 400 });
      }

      try {
        const res = await env.DB.prepare(
          `DELETE FROM subjects
           WHERE id = ? AND user_id = ?`
        )
          .bind(id, user_id)
          .run();

        const changes = res?.meta?.changes ?? 0;
        return Response.json({ ok: true, deleted: changes > 0, changes });
      } catch (e) {
        return Response.json(
          { ok: false, error: "DB delete failed", detail: String(e) },
          { status: 500 }
        );
      }
    }

    // --------------------
    // 7) UPDATE SUBJECT (for edit flow)
    // POST /subjects/update
    // body: { user_id, id, day, subject_code, subject_name, section, type, room, start_time, end_time, instructor }
    // --------------------
    if (url.pathname === "/subjects/update" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }

      const user_id = String(body?.user_id ?? "").trim();
      const id = Number(body?.id);

      if (!user_id) {
        return Response.json({ ok: false, error: "missing user_id" }, { status: 400 });
      }
      if (!Number.isFinite(id)) {
        return Response.json({ ok: false, error: "missing/invalid id" }, { status: 400 });
      }

      // required fields (แก้ไขควรส่งมาครบ จะนิ่งสุด)
      const required = [
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
        return Response.json(
          { ok: false, error: `missing: ${missing.join(", ")}` },
          { status: 400 }
        );
      }

      // normalize (เหมือน add)
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
        return Response.json(
          { ok: false, error: "DB update failed", detail: String(e) },
          { status: 500 }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
