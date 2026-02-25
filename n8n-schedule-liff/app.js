// ===== Config =====
const LIFF_ID = "2009146879-wz2WIruL";
const WEBHOOK_URL = "https://spu-n8n.spu.ac.th/webhook-test/liff/subjects/add"; // <- ใส่ webhook n8n ของคุณ

// ===== Elements =====
const form = document.getElementById("form");
const btnSubmit = document.getElementById("btnSubmit");
const btnReset = document.getElementById("btnReset");
const statusEl = document.getElementById("status");
const errEl = document.getElementById("err");
const okEl = document.getElementById("ok");

const el = (id) => document.getElementById(id);
const v = (id) => el(id).value.trim();

function setStatus(msg) { statusEl.textContent = msg || ""; }
function showError(msg) {
  errEl.hidden = !msg;
  errEl.textContent = msg || "";
  if (msg) okEl.hidden = true;
}
function showOk(msg) {
  okEl.hidden = !msg;
  okEl.textContent = msg || "";
  if (msg) errEl.hidden = true;
}
function setLoading(isLoading) {
  btnSubmit.disabled = isLoading;
  btnReset.disabled = isLoading;
}

// ===== Helpers =====
function normInstructor(name) {
  let s = String(name || "").trim();
  if (!s) return "";

  if (s.startsWith("อาจารย์")) {
    s = s.replace(/^อาจารย์\s*/, "");
    return "อ." + s;
  }
  if (s.startsWith("ครู")) {
    s = s.replace(/^ครู\s*/, "");
    return "อ." + s;
  }
  if (s.startsWith("อ.")) return s;

  return "อ." + s;
}

function validTime(t) {
  const s = String(t || "").trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return false;
  const hh = Number(s.slice(0, 2));
  const mm = Number(s.slice(3, 5));
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

// รองรับพิมพ์แบบคนไทย: 930, 1530, 9:5, 9.30, 14:00
function parseFlexibleTime(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";

  // กัน AM/PM ถ้าเผลอพิมพ์มา
  s = s.replace(/\s*(am|pm)\s*/ig, "").trim();

  // normalize separators
  s = s.replace(".", ":");

  // H:MM or HH:MM
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (m) {
    const hh = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const out = `${hh}:${mm}`;
    return validTime(out) ? out : "";
  }

  // digits only: 930 or 1530
  const digits = s.replace(/\D/g, "");
  if (digits.length === 3) {
    const out = `0${digits[0]}:${digits.slice(1)}`;
    return validTime(out) ? out : "";
  }
  if (digits.length === 4) {
    const out = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    return validTime(out) ? out : "";
  }

  return "";
}

function addMinutes(timeHHMM, deltaMin) {
  if (!validTime(timeHHMM)) return "";
  const hh = Number(timeHHMM.slice(0, 2));
  const mm = Number(timeHHMM.slice(3, 5));
  let total = hh * 60 + mm + deltaMin;

  if (total < 0) total = 0;
  if (total > 23 * 60 + 59) total = 23 * 60 + 59;

  const outHH = String(Math.floor(total / 60)).padStart(2, "0");
  const outMM = String(total % 60).padStart(2, "0");
  return `${outHH}:${outMM}`;
}

function quickValidate(payload) {
  const required = [
    "subject_code", "subject_name", "section", "type",
    "instructor", "day", "start_time", "end_time", "room"
  ];
  const missing = required.filter((k) => !payload[k] || String(payload[k]).trim() === "");
  if (missing.length) return `กรอกไม่ครบ: ${missing.join(", ")}`;

  if (!validTime(payload.start_time) || !validTime(payload.end_time)) {
    return "เวลาไม่ถูกต้อง (ใช้รูปแบบ 24 ชม. เช่น 14:00)";
  }
  if (payload.start_time >= payload.end_time) {
    return "เวลาเลิกต้องมากกว่าเวลาเริ่ม";
  }
  // กัน 00:00 แบบเผลอพิมพ์/หลุด
  if (payload.start_time === "00:00" || payload.end_time === "00:00") {
    return "เวลาเป็น 00:00 ดูเหมือนยังไม่ได้ใส่เวลา (ใช้ 24 ชม. เช่น 14:00)";
  }
  return "";
}

// ===== Events =====
el("instructor").addEventListener("blur", (e) => {
  e.target.value = normInstructor(e.target.value);
});

// auto-format time on blur
["start_time", "end_time"].forEach((id) => {
  el(id).addEventListener("blur", (e) => {
    const fixed = parseFlexibleTime(e.target.value);
    if (fixed) e.target.value = fixed;
  });
});

// +/- minute buttons
document.querySelectorAll(".tbtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    const delta = Number(btn.dataset.delta || "0");

    const curRaw = el(target).value.trim();
    const cur = parseFlexibleTime(curRaw);
    if (!cur) return;

    const next = addMinutes(cur, delta);
    if (next) el(target).value = next;
  });
});

btnReset.addEventListener("click", () => {
  form.reset();
  showError("");
  showOk("");
  setStatus("");
});

async function ensureLiff() {
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) {
    liff.login();
    throw new Error("redirecting-to-login");
  }
}

async function submit() {
  showError("");
  showOk("");
  setStatus("");

  if (!WEBHOOK_URL || WEBHOOK_URL.includes("PUT_YOUR_")) {
    showError("ยังไม่ได้ตั้งค่า WEBHOOK_URL (ต้องเป็น Production URL ของ n8n Webhook)");
    return;
  }

  setLoading(true);
  setStatus("กำลังเตรียม LIFF...");

  try {
    await ensureLiff();
    const profile = await liff.getProfile();

    const start_time = parseFlexibleTime(el("start_time").value);
    const end_time = parseFlexibleTime(el("end_time").value);

    // สะท้อนค่าที่ parse แล้วให้ user เห็น
    if (start_time) el("start_time").value = start_time;
    if (end_time) el("end_time").value = end_time;

    const payload = {
      user_id: profile.userId,
      subject_code: v("subject_code").toUpperCase(),
      subject_name: v("subject_name"),
      section: v("section"),
      type: el("type").value,
      instructor: normInstructor(v("instructor")),
      day: el("day").value,
      start_time,
      end_time,
      room: v("room"),
      source: "liff"
    };

    el("instructor").value = payload.instructor;

    const msg = quickValidate(payload);
    if (msg) {
      showError(msg);
      setLoading(false);
      return;
    }

    setStatus("กำลังส่งข้อมูลไปยังระบบ...");

    // ✅ ส่งแบบ text/plain ลด preflight CORS
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    setStatus(`HTTP Status: ${res.status}\n\nตอบกลับจากระบบ:\n${text}`);

    let data = {};
    try { data = JSON.parse(text); } catch (_) {}

    if (res.ok && data && data.ok === true) {
      showOk("บันทึกสำเร็จ ✅");
      setTimeout(() => liff.closeWindow(), 650);
      return;
    }

    if (data && data.error) showError(data.error);
    else showError("บันทึกไม่สำเร็จ (ระบบตอบกลับไม่ถูกต้อง)");

  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("redirecting-to-login")) return;

    showError("ส่งไม่สำเร็จ");
    setStatus(msg);
  } finally {
    setLoading(false);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});

// init
(async () => {
  try {
    setStatus("กำลังเตรียม LIFF...");
    await liff.init({ liffId: LIFF_ID });
    setStatus("พร้อมใช้งาน ✅ (เวลาใช้รูปแบบ 24 ชม. เช่น 14:00)");
  } catch (e) {
    setStatus("LIFF init error: " + String(e));
  }
})();
