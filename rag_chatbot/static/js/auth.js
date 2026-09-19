const $ = (sel) => document.querySelector(sel);

function setActiveTab(tab) {
  const signin = tab === "signin";
  $(".tab-btn[data-tab='signin']").classList.toggle("active", signin);
  $(".tab-btn[data-tab='signup']").classList.toggle("active", !signin);
  $("#panel-signin").classList.toggle("active", signin);
  $("#panel-signup").classList.toggle("active", !signin);

  const indicator = $("#tab-indicator");
  indicator.style.left = signin ? "0%" : "50%";
}

function showInlineError(el, show) {
  if (!el) return;
  el.classList.toggle("show", !!show);
}

function passwordStrength(password) {
  // Spec:
  // weak (< 6) = red 33%
  // medium (has number or symbol) = amber 66%
  // strong (both + 8+ chars) = green 100%
  const len = password.length;
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const hasNumOrSym = hasNumber || hasSymbol;

  if (len < 6) return { pct: 33, color: "var(--danger)", label: "Weak" };
  if (len >= 8 && hasNumber && hasSymbol) return { pct: 100, color: "var(--success)", label: "Strong" };
  if (hasNumOrSym) return { pct: 66, color: "var(--warning)", label: "Medium" };
  return { pct: 33, color: "var(--danger)", label: "Weak" };
}

function setPasswordStrength(password) {
  const fill = $("#password-strength-bar-fill");
  const label = $("#password-strength-label");
  if (!fill || !label) return;

  const s = passwordStrength(password);
  fill.style.width = `${s.pct}%`;
  fill.style.background = s.color;
  label.textContent = s.label;
}

function setConfirmMatchIndicator(pw1, pw2) {
  const icon = $("#confirm-match-icon");
  const confirmErr = $("#signup-confirm-error");
  if (!icon) return;

  const matches = pw1 && pw2 && pw1 === pw2;
  icon.textContent = matches ? "✓" : "✗";
  icon.style.color = matches ? "var(--success)" : "var(--danger)";
  showInlineError(confirmErr, !matches && pw2.length > 0);
}

function validateUsername(username) {
  const re = /^[a-zA-Z0-9_]{3,20}$/;
  return re.test(username);
}

function initSignIn() {
  const u = $("#signin-username");
  const p = $("#signin-password");
  const uErr = $("#signin-username-error");
  const pErr = $("#signin-password-error");
  const toggle = $("#signin-toggle-eye");
  if (toggle && p) {
    toggle.addEventListener("click", () => {
      p.type = p.type === "password" ? "text" : "password";
    });
  }

  const submit = $("#signin-submit");
  const form = submit?.closest("form");
  if (form) {
    form.addEventListener("submit", (e) => {
      let ok = true;
      ok = !!u?.value?.trim() && ok;
      ok = !!p?.value?.trim() && ok;
      showInlineError(uErr, !u?.value?.trim());
      showInlineError(pErr, !p?.value?.trim());
      if (!ok) e.preventDefault();

      if (!e.defaultPrevented) {
        submit.disabled = true;
        submit.textContent = "SIGNING IN...";
      }
    });
  }

  [u, p].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", () => {
      if (el === u) showInlineError(uErr, !el.value.trim());
      if (el === p) showInlineError(pErr, !el.value.trim());
    });
  });
}

function initSignUp() {
  const full = $("#signup-fullname");
  const uname = $("#signup-username");
  const email = $("#signup-email");
  const pw = $("#signup-password");
  const cpw = $("#signup-confirm-password");

  const fullErr = $("#signup-fullname-error");
  const unameErr = $("#signup-username-error");
  const emailErr = $("#signup-email-error");
  const pwErr = $("#signup-password-error");

  const togglePw = $("#signup-toggle-eye");
  const toggleCpw = null; // uses same widget styling, optional
  const confirmErr = $("#signup-confirm-error");

  // Eye toggle for sign-up password
  if (togglePw && pw) {
    togglePw.addEventListener("click", () => {
      pw.type = pw.type === "password" ? "text" : "password";
    });
  }

  const strengthBarFill = $("#password-strength-bar-fill");
  if (strengthBarFill) strengthBarFill.style.width = "0%";

  const form = $("#signup-form");
  if (form) {
    const submit = $("#signup-submit");
    form.addEventListener("submit", (e) => {
      const okFull = !!full?.value?.trim();
      const okU = uname && validateUsername(uname.value);
      const okE = email?.value?.includes("@");
      const okPw = (pw?.value?.length || 0) >= 6;
      const okMatch = pw?.value && cpw?.value && pw.value === cpw.value;

      showInlineError(fullErr, !okFull);
      showInlineError(unameErr, !okU);
      showInlineError(emailErr, !okE);
      showInlineError(pwErr, !okPw);
      showInlineError(confirmErr, !okMatch && (cpw?.value?.length || 0) > 0);

      if (!(okFull && okU && okE && okPw && okMatch)) {
        e.preventDefault();
        return;
      }
      if (submit) {
        submit.disabled = true;
        submit.textContent = "CREATING...";
      }
    });
  }

  [full, uname, email, pw, cpw].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", () => {
      const pwVal = pw?.value || "";
      setPasswordStrength(pwVal);
      setConfirmMatchIndicator(pwVal, cpw?.value || "");

      showInlineError(fullErr, !full.value.trim());
      showInlineError(unameErr, !validateUsername(uname?.value || ""));
      showInlineError(emailErr, !(email?.value || "").includes("@"));
      showInlineError(pwErr, (pw?.value?.length || 0) < 6);
    });
  });
}

function initFlashDismiss() {
  const btn = document.querySelector("[data-flash-close]");
  const banner = document.querySelector(".flash-banner");
  if (!btn || !banner) return;
  btn.addEventListener("click", () => {
    banner.remove();
  });
}

function init() {
  const t = localStorage.getItem("theme") || "dark";
  document.documentElement.dataset.theme = t;

  const indicator = $("#tab-indicator");
  if (indicator) indicator.style.left = "0%";

  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.addEventListener("click", () => setActiveTab(b.dataset.tab));
  });

  $("#to-signup")?.addEventListener("click", () => setActiveTab("signup"));
  $("#to-signin")?.addEventListener("click", () => setActiveTab("signin"));

  initFlashDismiss();
  initSignIn();
  initSignUp();
}

window.addEventListener("DOMContentLoaded", init);

