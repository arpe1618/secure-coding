/* 다시장 프론트엔드 SPA (프레임워크 없이 동작 — 빌드 불필요) */
"use strict";

const $app = document.getElementById("app");
const S = { me: null, view: { name: "feed" }, tab: "home", poll: null }; // 세션은 httpOnly 쿠키가 담당 (JS로 토큰 접근 불가)

// 외부 링크 감지 → 피싱 경고 표시용 (보안 진단서 §5)
const hasUrl = (t) => /(https?:\/\/|www\.)\S+|[a-z0-9-]+\.(com|net|org|kr|co|io|me|shop|link|xyz|site)(\/\S*)?/i.test(String(t || ""));
const LINK_WARN = `<span class="linkwarn">⚠️ 외부 링크 주의 — 다시장 밖에서의 결제·개인정보 요구는 사기일 수 있어요. 안전거래는 앱 안에서만!</span>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => Number(n).toLocaleString("ko-KR") + "원";
const timeOf = (iso) => (iso ? iso.slice(11, 16) : "");

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2400);
}

/* ── API 헬퍼 ── */
function getCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  // CSRF: 상태변경 요청에는 csrf 쿠키값을 헤더로도 함께 전송 (double-submit)
  const authPath = path === "/auth/login" || path === "/auth/signup";
  if (method !== "GET" && method !== "HEAD" && !authPath) {
    const csrf = getCookie("csrf");
    // csrf 쿠키가 없으면 = 예전 버전에서 로그인된 낡은 세션. 재로그인해야 발급되므로 즉시 유도.
    if (!csrf) {
      S.me = null; renderAuth();
      throw new Error("세션이 오래되었습니다. 다시 로그인해 주세요.");
    }
    headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch("/api" + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { S.me = null; renderAuth(); throw new Error(data.error || "로그인이 필요합니다."); }
  if (res.status === 403 && data.blocked) { S.blockedScreen = true; render(); throw new Error(data.error); }
  // CSRF 토큰 불일치(403)도 재로그인으로 복구
  if (res.status === 403 && /보안 토큰/.test(data.error || "")) {
    S.me = null; renderAuth();
    throw new Error("세션이 오래되었습니다. 다시 로그인해 주세요.");
  }
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
}

async function logout(manual = true) {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* 쿠키 만료 등 */ }
  S.me = null; S.blockedScreen = false;
  S.view = { name: "feed" }; S.tab = "home";
  if (manual) toast("로그아웃했습니다.");
  renderAuth();
}

function go(name, data = {}, tab) {
  clearInterval(S.poll); S.poll = null;
  S.view = { name, ...data };
  if (tab) S.tab = tab;
  render();
}

/* ── 렌더 디스패처 ── */
async function render() {
  if (S.blockedScreen) return renderBlocked();
  if (!S.me) {
    try { S.me = (await api("/auth/me")).user; } catch { return; } // 401이면 api()가 로그인 화면 표시
  }
  const views = { feed: viewFeed, detail: viewDetail, sell: viewSell, chatList: viewChatList, chatRoom: viewChatRoom, globalChat: viewGlobalChat, wallet: viewWallet, my: viewMy, profile: viewProfile, admin: viewAdmin };
  $app.innerHTML = shell();
  bindShell();
  await (views[S.view.name] || viewFeed)(document.getElementById("main"));
}

function shell() {
  const m = S.me;
  const tabs = [
    ["home", "🏠", "홈", "feed"], ["chat", "💬", "채팅", "chatList"], ["sell", "➕", "판매", "sell"], ["wallet", "💸", "지갑", "wallet"],
    m.is_admin ? ["adminTab", "🛡️", "관리", "admin"] : ["my", "👤", "마이", "my"],
  ];
  return `
    <header>
      <button class="logo" data-go="feed" data-tab="home">♻️ 다시장</button>
      <div style="display:flex;gap:10px;align-items:center">
        <span class="chip ${m.is_admin ? "admin" : ""}">${m.is_admin ? "관리자" : esc(m.name)}</span>
        <button class="linkbtn" id="logoutBtn">로그아웃</button>
      </div>
    </header>
    <main id="main"></main>
    <nav class="tabs">
      ${tabs.map(([k, ico, label, view]) => `
        <button class="${S.tab === k ? "on" : ""}" data-go="${view}" data-tab="${k}">
          <span class="ico">${ico}</span>${label}
        </button>`).join("")}
    </nav>`;
}

function bindShell() {
  document.getElementById("logoutBtn").onclick = () => logout();
  $app.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go, {}, b.dataset.tab)));
}

/* ═══ 인증 ═══ */
function renderAuth() {
  let mode = "in";
  $app.innerHTML = `
    <div class="auth">
      <div style="font-size:44px;margin-bottom:14px">♻️</div>
      <h1>다시장</h1>
      <p class="tag">쓰던 물건이 다시 장터로 — 우리 동네 중고거래</p>
      <div class="auth-card">
        <div class="seg"><button id="segIn" class="on">로그인</button><button id="segUp">회원가입</button></div>
        <input id="aName" placeholder="닉네임" autocomplete="username" />
        <input id="aPw" type="password" placeholder="비밀번호" autocomplete="current-password" />
        <p class="hint" id="aErr" style="color:var(--danger);display:none"></p>
        <button class="btn primary" id="aSubmit">로그인</button>
        <p class="hint">신규 가입 후 지갑 탭에서 충전하고 거래를 시작하세요.<br/>관리자 계정은 서버 .env 파일에서 설정합니다.</p>
      </div>
    </div>`;
  const seg = (m) => {
    mode = m;
    document.getElementById("segIn").className = m === "in" ? "on" : "";
    document.getElementById("segUp").className = m === "up" ? "on" : "";
    document.getElementById("aSubmit").textContent = m === "in" ? "로그인" : "가입하고 시작하기";
  };
  document.getElementById("segIn").onclick = () => seg("in");
  document.getElementById("segUp").onclick = () => seg("up");
  const submit = async () => {
    const err = document.getElementById("aErr");
    err.style.display = "none";
    try {
      const data = await api(mode === "in" ? "/auth/login" : "/auth/signup", {
        method: "POST",
        body: { name: document.getElementById("aName").value, password: document.getElementById("aPw").value },
      });
      S.me = data.user; // 토큰은 서버가 httpOnly 쿠키로 심어줌 — JS는 저장하지 않음
      go("feed", {}, "home");
    } catch (e) { err.textContent = e.message; err.style.display = "block"; }
  };
  document.getElementById("aSubmit").onclick = submit;
  document.getElementById("aPw").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function renderBlocked() {
  $app.innerHTML = `
    <div class="empty" style="padding-top:35vh">
      <div class="big">🚫</div>
      <p style="font-weight:800;font-size:17px;color:var(--ink)">계정이 차단되었습니다</p>
      <p style="margin:8px 0 20px">운영정책 위반으로 이용이 제한되었습니다.</p>
      <button class="btn ink" id="outBtn" style="width:auto;padding:12px 28px">로그아웃</button>
    </div>`;
  document.getElementById("outBtn").onclick = () => logout(false);
}

/* ═══ 홈 피드: 상품 조회 + 검색 ═══ */
async function viewFeed(main) {
  S.feedQ = S.feedQ || ""; S.feedCat = S.feedCat || "전체";
  const load = async () => {
    const { products, categories } = await api(`/products?q=${encodeURIComponent(S.feedQ)}&category=${encodeURIComponent(S.feedCat)}`);
    main.innerHTML = `
      <div class="px" style="padding-top:16px">
        <div class="search">🔍 <input id="q" placeholder="어떤 물건을 찾으세요?" value="${esc(S.feedQ)}" /></div>
        <div class="cats">
          ${["전체", ...categories].map((c) => `<button data-cat="${esc(c)}" class="${S.feedCat === c ? "on" : ""}">${esc(c)}</button>`).join("")}
        </div>
        ${products.length === 0 ? `<div class="empty"><div class="big">🧺</div>조건에 맞는 상품이 없어요.<br/>검색어를 바꾸거나 첫 상품을 올려 보세요.</div>` : ""}
        <div class="stack">
          ${products.map((p) => `
            <button class="card row" data-id="${p.id}">
              <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="" />` : "📦"}</div>
              <div style="flex:1;min-width:0">
                <div style="display:flex;gap:8px;align-items:center">
                  <span class="title">${esc(p.title)}</span>
                  ${p.status === "sold" ? `<span class="badge">판매완료</span>` : ""}
                  ${p.status === "blocked" ? `<span class="badge danger">차단됨</span>` : ""}
                </div>
                <div class="meta">${esc(p.seller_name)} · ${esc(p.category)} · ${esc(p.created_at.slice(5, 16))}</div>
                <div style="margin-top:8px"><span class="price-tag">${won(p.price)}</span></div>
              </div>
            </button>`).join("")}
        </div>
      </div>`;
    const q = document.getElementById("q");
    q.onkeydown = (e) => { if (e.key === "Enter") { S.feedQ = q.value; load(); } };
    main.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { S.feedCat = b.dataset.cat; load(); }));
    main.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => go("detail", { id: +b.dataset.id })));
  };
  await load();
}

/* ═══ 상품 상세: 채팅 · 안전거래 구매 · 신고 ═══ */
async function viewDetail(main) {
  let p;
  try { p = (await api("/products/" + S.view.id)).product; }
  catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const mine = p.seller_id === S.me.id;
  main.innerHTML = `
    <div class="px" style="padding-top:16px">
      <button class="linkbtn" id="back" style="font-weight:700;margin-bottom:12px">← 목록으로</button>
      <div class="card" style="overflow:hidden">
        <div class="detail-hero">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" />` : "📦"}</div>
        <div style="padding:16px">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
            <span style="font-weight:800;font-size:18px">${esc(p.title)}</span>
            <span class="price-tag" style="font-size:14px">${won(p.price)}</span>
          </div>
          <div class="meta"><a href="#" id="sellerLink" style="color:var(--primary);font-weight:700;text-decoration:underline">${esc(p.seller_name)}</a> · ${esc(p.category)} · ${esc(p.created_at.slice(0, 16))}</div>
          <p style="font-size:14px;line-height:1.6;margin-top:14px;white-space:pre-wrap">${esc(p.description) || "설명이 없습니다."}</p>
          ${hasUrl(p.description) ? LINK_WARN : ""}
          ${p.status === "sold" ? `<p class="meta" style="margin-top:12px;font-weight:700">이미 판매가 완료된 상품입니다.</p>` : ""}
          ${p.status === "blocked" ? `<p class="meta" style="margin-top:12px;font-weight:700;color:var(--danger)">관리자에 의해 차단된 상품입니다.</p>` : ""}
        </div>
      </div>

      ${!mine && p.status === "active" ? `
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn outline" id="chatBtn" style="flex:1">💬 판매자와 채팅</button>
          <button class="btn primary" id="buyBtn" style="flex:1">안전거래 구매 · ${won(p.price)}</button>
        </div>
        <p class="hint" style="margin-top:8px">안전거래: 결제 금액은 에스크로에 보관되며, 물건을 받고 <b>구매 확정</b>해야 판매자에게 정산됩니다.</p>` : ""}
      ${mine ? `<p class="empty" style="padding:20px">내가 올린 상품입니다.</p>
        ${p.status !== "sold" ? `<button class="btn ghost" id="delBtn" style="width:100%">상품 삭제</button>` : ""}` : ""}

      ${!mine ? `
        <div style="margin-top:16px" id="reportArea">
          <button class="linkbtn" id="reportOpen" style="color:var(--danger)">🚩 이 상품 또는 판매자 신고하기</button>
        </div>` : ""}
    </div>`;

  document.getElementById("back").onclick = () => go("feed", {}, "home");
  document.getElementById("sellerLink").onclick = (e) => { e.preventDefault(); go("profile", { id: p.seller_id }); };
  if (!mine && p.status === "active") {
    document.getElementById("chatBtn").onclick = async () => {
      try { const { chat_id } = await api("/chats", { method: "POST", body: { product_id: p.id } }); go("chatRoom", { id: chat_id }, "chat"); }
      catch (e) { toast(e.message); }
    };
    document.getElementById("buyBtn").onclick = async () => {
      if (!confirm(`${won(p.price)}을 결제할까요?\n금액은 구매 확정 전까지 에스크로에 보관됩니다.`)) return;
      try { await api("/wallet/orders", { method: "POST", body: { product_id: p.id } }); toast("결제 완료! 지갑 탭 > 주문에서 구매 확정할 수 있어요."); go("wallet", {}, "wallet"); }
      catch (e) { toast(e.message); }
    };
  }
  const delBtn = document.getElementById("delBtn");
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm("상품을 삭제할까요?")) return;
    try { await api("/products/" + p.id, { method: "DELETE" }); toast("삭제했습니다."); go("feed", {}, "home"); } catch (e) { toast(e.message); }
  };
  const ro = document.getElementById("reportOpen");
  if (ro) ro.onclick = () => {
    document.getElementById("reportArea").innerHTML = `
      <div class="report-box stack">
        <p style="font-size:12px;font-weight:700;color:var(--danger)">신고 사유를 알려 주세요</p>
        <input id="rReason" placeholder="예: 가품 판매, 외부 링크 유도" />
        <div style="display:flex;gap:8px">
          <button class="btn danger sm" id="rProduct" style="flex:1">상품 신고</button>
          <button class="btn sm" id="rUser" style="flex:1;background:#fff;color:var(--danger)">판매자 신고</button>
        </div>
      </div>`;
    const send = async (kind, targetId) => {
      const reason = document.getElementById("rReason").value.trim();
      if (!reason) return toast("신고 사유를 입력해 주세요.");
      try { await api("/reports", { method: "POST", body: { kind, target_id: targetId, reason } }); toast("신고가 접수되었습니다. 관리자가 검토합니다."); go("detail", { id: p.id }); }
      catch (e) { toast(e.message); }
    };
    document.getElementById("rProduct").onclick = () => send("product", p.id);
    document.getElementById("rUser").onclick = () => send("user", p.seller_id);
  };
}

/* ═══ 판매 등록 (이미지 업로드 포함) ═══ */
async function viewSell(main) {
  main.innerHTML = `
    <div class="px" style="padding-top:16px">
      <p class="h2">내 물건 팔기</p>
      <div class="card stack" style="padding:16px">
        <input type="file" id="sImg" accept="image/*" />
        <input id="sTitle" placeholder="상품명" maxlength="60" />
        <input id="sPrice" placeholder="가격 (원)" inputmode="numeric" />
        <select id="sCat"><option>디지털</option><option>가구</option><option>생활</option><option>패션</option><option>기타</option></select>
        <textarea id="sDesc" rows="4" placeholder="상품 설명 — 상태, 거래 방법 등을 적어 주세요."></textarea>
        <button class="btn primary" id="sSubmit">등록하기</button>
      </div>
    </div>`;
  document.getElementById("sSubmit").onclick = async () => {
    const fd = new FormData();
    fd.append("title", document.getElementById("sTitle").value);
    fd.append("price", document.getElementById("sPrice").value.replace(/[^0-9]/g, ""));
    fd.append("category", document.getElementById("sCat").value);
    fd.append("description", document.getElementById("sDesc").value);
    const f = document.getElementById("sImg").files[0];
    if (f) fd.append("image", f);
    try { await api("/products", { method: "POST", form: fd }); toast("상품이 등록되었습니다."); go("feed", {}, "home"); }
    catch (e) { toast(e.message); }
  };
}

/* ═══ 채팅 목록 / 대화방 (폴링으로 실시간 갱신) ═══ */
async function viewChatList(main) {
  const { chats } = await api("/chats");
  main.innerHTML = `
    <div class="px" style="padding-top:16px">
      <p class="h2">채팅</p>
      <button class="card row" id="globalChatBtn" style="margin-bottom:10px">
        <div class="thumb sm" style="background:var(--amber)">🌐</div>
        <div style="flex:1">
          <div class="title">전체 채팅</div>
          <div class="meta">다시장의 모든 유저가 함께 이야기하는 공간</div>
        </div>
      </button>
      ${chats.length === 0 ? `<div class="empty"><div class="big">💬</div>아직 1대1 대화가 없어요.<br/>상품 페이지에서 판매자에게 말을 걸어 보세요.</div>` : ""}
      <div class="stack">
        ${chats.map((c) => {
          const other = c.buyer_id === S.me.id ? c.seller_name : c.buyer_name;
          return `
          <button class="card row" data-id="${c.id}">
            <div class="thumb sm">${c.image ? `<img src="${esc(c.image)}" alt=""/>` : "📦"}</div>
            <div style="flex:1;min-width:0">
              <div class="title">${esc(other)} <span style="font-weight:400;font-size:12px;color:var(--sub)">· ${esc(c.product_title)}</span></div>
              <div class="meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.last_text || "대화를 시작해 보세요")}</div>
            </div>
            <span class="meta">${timeOf(c.last_at)}</span>
          </button>`;
        }).join("")}
      </div>
    </div>`;
  document.getElementById("globalChatBtn").onclick = () => go("globalChat", {}, "chat");
  main.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => go("chatRoom", { id: +b.dataset.id })));
}

/* ═══ 전체 채팅 (모든 유저 공용, 폴링으로 실시간 갱신) ═══ */
async function viewGlobalChat(main) {
  let lastId = 0;
  main.innerHTML = `
    <div class="chat-room">
      <div class="chat-head">
        <button class="linkbtn" id="back" style="font-size:16px;text-decoration:none">←</button>
        <div style="text-align:center">
          <div style="font-weight:700;font-size:14px">🌐 전체 채팅</div>
          <div class="meta">모든 유저가 함께하는 공간</div>
        </div>
        <span style="width:24px"></span>
      </div>
      <div class="msgs" id="gmsgs"></div>
      <div class="chat-input">
        <input id="gText" placeholder="모두에게 메시지 보내기" maxlength="500" />
        <button id="gSend">전송</button>
      </div>
    </div>`;
  const box = document.getElementById("gmsgs");
  const append = (list) => {
    for (const m of list) {
      lastId = Math.max(lastId, m.id);
      const mine = m.sender_id === S.me.id;
      const div = document.createElement("div");
      div.className = "bubble " + (mine ? "me" : "other");
      div.innerHTML = `${mine ? "" : `<span style="display:block;font-size:11px;font-weight:700;opacity:.7;margin-bottom:2px">${esc(m.sender_name)}</span>`}${esc(m.text)}${hasUrl(m.text) ? LINK_WARN : ""}<span class="t">${timeOf(m.created_at)}</span>`;
      box.appendChild(div);
    }
    if (list.length) box.scrollTop = box.scrollHeight;
  };
  const first = await api("/global-chat");
  if (first.messages.length === 0) box.innerHTML = `<p class="empty" style="padding:32px">아직 메시지가 없어요. 첫 인사를 남겨 보세요!</p>`;
  append(first.messages);
  S.poll = setInterval(async () => {
    try { const d = await api(`/global-chat?after=${lastId}`); append(d.messages); } catch { /* 재시도 */ }
  }, 2500);
  document.getElementById("back").onclick = () => go("chatList", {}, "chat");
  const input = document.getElementById("gText");
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try { await api("/global-chat", { method: "POST", body: { text } }); const d = await api(`/global-chat?after=${lastId}`); append(d.messages); }
    catch (e) { toast(e.message); }
  };
  document.getElementById("gSend").onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter") send(); };
}

/* ═══ 사용자 프로필 조회 (다른 유저의 소개글 + 판매 상품) ═══ */
async function viewProfile(main) {
  let data;
  try { data = await api("/users/" + S.view.id); }
  catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const { user, products } = data;
  main.innerHTML = `
    <div class="px" style="padding-top:16px">
      <button class="linkbtn" id="back" style="font-weight:700;margin-bottom:12px">← 뒤로</button>
      <div class="card" style="padding:18px">
        <div class="row" style="padding:0">
          <div class="thumb sm" style="border-radius:99px">👤</div>
          <div>
            <div style="font-weight:800">${esc(user.name)}</div>
            <div class="meta">가입일 ${esc((user.created_at || "").slice(0, 10))}</div>
          </div>
        </div>
        <p style="font-size:13px;line-height:1.6;margin-top:12px;white-space:pre-wrap;color:var(--sub)">${esc(user.bio) || "아직 소개글이 없어요."}</p>
      </div>
      <p class="section-label">${esc(user.name)}님의 판매 상품 (${products.length})</p>
      ${products.length === 0 ? `<p class="empty" style="padding:20px">판매 중인 상품이 없어요.</p>` : ""}
      <div class="stack">
        ${products.map((p) => `
          <button class="card row" data-id="${p.id}">
            <div class="thumb sm">${p.image ? `<img src="${esc(p.image)}" alt=""/>` : "📦"}</div>
            <div style="flex:1">
              <div class="title">${esc(p.title)}</div>
              <div class="meta">${p.status === "active" ? "판매 중" : "판매완료"}</div>
            </div>
            <span class="price-tag">${won(p.price)}</span>
          </button>`).join("")}
      </div>
    </div>`;
  document.getElementById("back").onclick = () => history.length ? go("feed", {}, "home") : go("feed", {}, "home");
  main.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => go("detail", { id: +b.dataset.id })));
}

async function viewChatRoom(main) {
  let lastId = 0;
  const { chat, messages } = await api(`/chats/${S.view.id}/messages`);
  const otherName = chat.buyer_id === S.me.id ? chat.seller_name : chat.buyer_name;
  const otherId = chat.buyer_id === S.me.id ? chat.seller_id : chat.buyer_id;
  main.innerHTML = `
    <div class="chat-room">
      <div class="chat-head">
        <button class="linkbtn" id="back" style="font-size:16px;text-decoration:none">←</button>
        <div style="text-align:center">
          <div style="font-weight:700;font-size:14px">${esc(otherName)}</div>
          <div class="meta">${esc(chat.product_title)} · ${won(chat.price)}</div>
        </div>
        <button class="linkbtn" id="reportUser" style="color:var(--danger)">🚩 신고</button>
      </div>
      <div class="msgs" id="msgs">
        ${messages.length === 0 ? `<p class="empty" style="padding:32px">첫 메시지를 보내 대화를 시작하세요.</p>` : ""}
      </div>
      <div class="chat-input">
        <input id="msgText" placeholder="메시지 입력" maxlength="1000" />
        <button id="msgSend">전송</button>
      </div>
    </div>`;
  const box = document.getElementById("msgs");
  const append = (list) => {
    for (const m of list) {
      lastId = Math.max(lastId, m.id);
      const div = document.createElement("div");
      div.className = "bubble " + (m.sender_id === S.me.id ? "me" : "other");
      div.innerHTML = `${esc(m.text)}${hasUrl(m.text) ? LINK_WARN : ""}<span class="t">${timeOf(m.created_at)}</span>`;
      box.appendChild(div);
    }
    if (list.length) box.scrollTop = box.scrollHeight;
  };
  append(messages);
  S.poll = setInterval(async () => {
    try { const d = await api(`/chats/${chat.id}/messages?after=${lastId}`); append(d.messages); } catch { /* 폴링 실패는 조용히 재시도 */ }
  }, 2500);

  document.getElementById("back").onclick = () => go("chatList", {}, "chat");
  document.getElementById("reportUser").onclick = async () => {
    const reason = prompt("신고 사유를 입력해 주세요.");
    if (!reason) return;
    try { await api("/reports", { method: "POST", body: { kind: "user", target_id: otherId, reason } }); toast("신고가 접수되었습니다."); } catch (e) { toast(e.message); }
  };
  const input = document.getElementById("msgText");
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await api(`/chats/${chat.id}/messages`, { method: "POST", body: { text } });
      const d = await api(`/chats/${chat.id}/messages?after=${lastId}`); append(d.messages);
    } catch (e) { toast(e.message); }
  };
  document.getElementById("msgSend").onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter") send(); };
}

/* ═══ 지갑: 충전(PG) · 송금 · 주문 · 내역 ═══ */
async function viewWallet(main) {
  const [{ user }, { orders }, { transactions }] = await Promise.all([
    api("/auth/me"), api("/wallet/orders"), api("/wallet/transactions"),
  ]);
  S.me = user;
  let chargeAmt = 10000;
  main.innerHTML = `
    <div class="px" style="padding-top:16px">
      <div class="balance-card">
        <div class="label">내 다시장 지갑</div>
        <div class="amount">${won(user.balance)}</div>
      </div>

      <div class="card stack" style="padding:16px;margin-top:14px">
        <p style="font-weight:700;font-size:14px">지갑 충전</p>
        <div class="amounts" id="amts">
          ${[5000, 10000, 30000, 50000, 100000].map((a) => `<button data-a="${a}" class="${a === chargeAmt ? "on" : ""}">${a.toLocaleString()}원</button>`).join("")}
        </div>
        <button class="btn ink" id="chargeBtn">충전하기</button>
      </div>

      <div class="card stack" style="padding:16px;margin-top:14px">
        <p style="font-weight:700;font-size:14px">송금하기</p>
        <input id="tName" placeholder="받는 사람 닉네임" />
        <div style="display:flex;gap:8px">
          <input id="tAmt" placeholder="금액 (원)" inputmode="numeric" style="flex:1" />
          <button class="btn primary sm" id="tSend" style="padding:0 20px">보내기</button>
        </div>
      </div>

      <p class="section-label">내 주문 (안전거래)</p>
      ${orders.length === 0 ? `<p class="empty" style="padding:20px">주문 내역이 없어요.</p>` : ""}
      <div class="stack">
        ${orders.map((o) => {
          const buying = o.buyer_id === S.me.id;
          const st = { paid: "에스크로 보관 중", completed: "거래 완료", refunded: "환불됨" }[o.status];
          return `
          <div class="card" style="padding:13px">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <div>
                <div class="title">${esc(o.product_title)} · ${won(o.amount)}</div>
                <div class="meta">${buying ? "구매" : "판매"} · 상대: ${esc(buying ? o.seller_name : o.buyer_name)} · <span class="badge ${o.status === "paid" ? "" : o.status === "completed" ? "ok" : "danger"}">${st}</span></div>
              </div>
              ${buying && o.status === "paid" ? `<button class="btn primary sm" data-confirm="${o.id}">구매 확정</button>` : ""}
            </div>
          </div>`;
        }).join("")}
      </div>

      <p class="section-label">거래 내역</p>
      ${transactions.length === 0 ? `<p class="empty" style="padding:20px">아직 거래 내역이 없어요.</p>` : ""}
      <div class="stack" style="margin-bottom:16px">
        ${transactions.map((t) => {
          const out = t.from_id === S.me.id;
          return `
          <div class="card row" style="justify-content:space-between">
            <div>
              <div class="title" style="font-size:13px">${esc(t.memo)}</div>
              <div class="meta">${out ? `→ ${esc(t.to_name || "에스크로")}` : `← ${esc(t.from_name || "외부 결제")}`} · ${esc(t.created_at)}</div>
            </div>
            <span style="font-weight:800;font-size:13px;color:${out ? "var(--danger)" : "var(--primary)"}">${out ? "−" : "+"}${won(t.amount)}</span>
          </div>`;
        }).join("")}
      </div>
    </div>`;

  document.querySelectorAll("#amts button").forEach((b) => (b.onclick = () => {
    chargeAmt = +b.dataset.a;
    document.querySelectorAll("#amts button").forEach((x) => x.classList.toggle("on", x === b));
  }));

  document.getElementById("chargeBtn").onclick = async () => {
    try {
      const c = await api("/payments/charges", { method: "POST", body: { amount: chargeAmt } });
      if (c.mode === "mock") {
        if (!confirm(`[모의 결제]\n${won(c.amount)}을 충전할까요?\n(실서비스에서는 이 자리에 토스페이먼츠 결제창이 열립니다)`)) return;
        await api("/payments/charges/mock-confirm", { method: "POST", body: { order_no: c.order_no } });
        toast(`${won(c.amount)} 충전 완료!`);
        go("wallet", {}, "wallet");
      } else {
        await loadTossSdk();
        const toss = window.TossPayments(c.client_key);
        const payment = toss.payment({ customerKey: "user_" + S.me.id });
        await payment.requestPayment({
          method: "CARD",
          amount: { currency: "KRW", value: c.amount },
          orderId: c.order_no,
          orderName: c.order_name,
          successUrl: location.origin + "/payment/success",
          failUrl: location.origin + "/payment/fail",
        });
      }
    } catch (e) { toast(e.message || "결제를 취소했습니다."); }
  };

  document.getElementById("tSend").onclick = async () => {
    const to_name = document.getElementById("tName").value.trim();
    const amount = parseInt(document.getElementById("tAmt").value.replace(/[^0-9]/g, ""), 10);
    if (!to_name || !amount) return toast("받는 사람과 금액을 입력해 주세요.");
    try { await api("/wallet/transfer", { method: "POST", body: { to_name, amount } }); toast(`${esc(to_name)}님에게 ${won(amount)} 송금 완료`); go("wallet", {}, "wallet"); }
    catch (e) { toast(e.message); }
  };

  main.querySelectorAll("[data-confirm]").forEach((b) => (b.onclick = async () => {
    if (!confirm("물건을 잘 받으셨나요? 구매 확정하면 판매자에게 정산됩니다.")) return;
    try { await api(`/wallet/orders/${b.dataset.confirm}/confirm`, { method: "POST" }); toast("구매 확정! 판매자에게 정산되었습니다."); go("wallet", {}, "wallet"); }
    catch (e) { toast(e.message); }
  }));
}

function loadTossSdk() {
  return new Promise((resolve, reject) => {
    if (window.TossPayments) return resolve();
    const s = document.createElement("script");
    s.src = "https://js.tosspayments.com/v2/standard";
    s.onload = resolve; s.onerror = () => reject(new Error("결제 모듈을 불러오지 못했습니다."));
    document.head.appendChild(s);
  });
}

/* ═══ 마이페이지 ═══ */
async function viewMy(main) {
  const [{ user }, { products }] = await Promise.all([api("/auth/me"), api("/products?category=전체")]);
  S.me = user;
  const mine = products.filter((p) => p.seller_id === user.id);
  main.innerHTML = `
    <div class="px" style="padding-top:16px">
      <div class="card" style="padding:18px">
        <div class="row" style="padding:0">
          <div class="thumb sm" style="border-radius:99px">👤</div>
          <div>
            <div style="font-weight:800">${esc(user.name)}</div>
            <div class="meta">잔액 ${won(user.balance)} · 판매 상품 ${mine.length}개</div>
          </div>
        </div>
        <p class="section-label" style="margin-top:14px">소개글</p>
        <textarea id="myBio" rows="3" maxlength="200" placeholder="자기소개를 적어 보세요. 다른 유저에게 보입니다.">${esc(user.bio)}</textarea>
        <button class="btn ghost sm" id="bioSave" style="width:100%;margin-top:8px">소개글 저장</button>
      </div>

      <div class="card stack" style="padding:16px;margin-top:14px">
        <p style="font-weight:700;font-size:14px">비밀번호 변경</p>
        <input id="pwOld" type="password" placeholder="현재 비밀번호" autocomplete="current-password" />
        <input id="pwNew" type="password" placeholder="새 비밀번호 (4자 이상)" autocomplete="new-password" />
        <button class="btn ink" id="pwSave">변경하기</button>
      </div>

      <p class="section-label">내가 올린 상품</p>
      ${mine.length === 0 ? `<p class="empty" style="padding:20px">아직 올린 상품이 없어요. 판매 탭에서 등록해 보세요.</p>` : ""}
      <div class="stack">
        ${mine.map((p) => `
          <button class="card row" data-id="${p.id}">
            <div class="thumb sm">${p.image ? `<img src="${esc(p.image)}" alt=""/>` : "📦"}</div>
            <div style="flex:1">
              <div class="title">${esc(p.title)}</div>
              <div class="meta">${p.status === "active" ? "판매 중" : p.status === "sold" ? "판매완료" : "관리자에 의해 차단됨"}</div>
            </div>
            <span class="price-tag">${won(p.price)}</span>
          </button>`).join("")}
      </div>
    </div>`;
  main.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => go("detail", { id: +b.dataset.id })));
  document.getElementById("bioSave").onclick = async () => {
    try { await api("/auth/me", { method: "PUT", body: { bio: document.getElementById("myBio").value } }); toast("소개글을 저장했습니다."); }
    catch (e) { toast(e.message); }
  };
  document.getElementById("pwSave").onclick = async () => {
    const old_password = document.getElementById("pwOld").value;
    const new_password = document.getElementById("pwNew").value;
    if (!old_password || !new_password) return toast("현재 비밀번호와 새 비밀번호를 입력해 주세요.");
    try {
      await api("/auth/password", { method: "PUT", body: { old_password, new_password } });
      toast("비밀번호를 변경했습니다.");
      document.getElementById("pwOld").value = ""; document.getElementById("pwNew").value = "";
    } catch (e) { toast(e.message); }
  };
}

/* ═══ 관리자 콘솔 ═══ */
async function viewAdmin(main) {
  S.adminSec = S.adminSec || "reports";
  S.adminPage = S.adminPage || 1;
  const load = async () => {
    const sum = await api("/admin/summary");
    const secs = [["reports", `신고${sum.open_reports ? ` (${sum.open_reports})` : ""}`], ["users", "유저"], ["products", "상품"], ["orders", "주문"], ["transactions", "거래"]];
    main.innerHTML = `
      <div class="px" style="padding-top:16px">
        <p class="h2" style="margin-top:0">관리자 콘솔</p>
        <div class="stats">
          <div class="stat"><div class="n">${sum.users}</div><div class="l">유저 (차단 ${sum.blocked_users})</div></div>
          <div class="stat"><div class="n">${sum.products}</div><div class="l">상품 (차단 ${sum.blocked_products})</div></div>
          <div class="stat"><div class="n">${won(sum.escrow_held)}</div><div class="l">에스크로 보관액</div></div>
        </div>
        <div class="cats">
          ${secs.map(([k, label]) => `<button data-sec="${k}" class="${S.adminSec === k ? "on" : ""}">${label}</button>`).join("")}
        </div>
        <div id="adminBody" class="stack" style="margin-bottom:16px"></div>
      </div>`;
    main.querySelectorAll("[data-sec]").forEach((b) => (b.onclick = () => { S.adminSec = b.dataset.sec; S.adminPage = 1; load(); }));
    const body = document.getElementById("adminBody");
    const PG = `&page=${S.adminPage}`;
    const pager = (count) => {
      const div = document.createElement("div");
      div.style.cssText = "display:flex;gap:8px;justify-content:center;margin-top:4px";
      div.innerHTML = `${S.adminPage > 1 ? `<button class="btn ghost sm" id="pgPrev">← 이전</button>` : ""}
        <span class="meta" style="align-self:center">${S.adminPage} 페이지</span>
        ${count >= 100 ? `<button class="btn ghost sm" id="pgNext">다음 →</button>` : ""}`;
      body.after(div);
      const pv = document.getElementById("pgPrev"), nx = document.getElementById("pgNext");
      if (pv) pv.onclick = () => { S.adminPage--; load(); };
      if (nx) nx.onclick = () => { S.adminPage++; load(); };
    };

    if (S.adminSec === "reports") {
      const { reports } = await api("/admin/reports?x=1" + PG); pager(reports.length);
      body.innerHTML = reports.length === 0 ? `<p class="empty">접수된 신고가 없습니다.</p>` : reports.map((r) => `
        <div class="card" style="padding:13px;border-color:${r.resolved ? "var(--line)" : "var(--danger)"}">
          <div style="display:flex;justify-content:space-between">
            <span class="title">${r.kind === "user" ? "👤 유저" : "📦 상품"}: ${esc(r.target_label || "(삭제됨)")}</span>
            <span class="badge ${r.resolved ? "ok" : "danger"}">${r.resolved ? "처리됨" : "미처리"}</span>
          </div>
          <div class="meta">사유: ${esc(r.reason)} · 신고자: ${esc(r.reporter_name)} · ${esc(r.created_at)}</div>
          ${!r.resolved ? `
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn danger sm" data-act="block" data-r="${r.id}" style="flex:1">차단</button>
              <button class="btn ghost sm" data-act="dismiss" data-r="${r.id}" style="flex:1">문제 없음</button>
            </div>` : ""}
        </div>`).join("");
      body.querySelectorAll("[data-r]").forEach((b) => (b.onclick = async () => {
        try { await api(`/admin/reports/${b.dataset.r}/resolve`, { method: "POST", body: { action: b.dataset.act } }); toast(b.dataset.act === "block" ? "차단 처리했습니다." : "문제 없음으로 처리했습니다."); load(); }
        catch (e) { toast(e.message); }
      }));
    }

    if (S.adminSec === "users") {
      const { users } = await api("/admin/users?x=1" + PG); pager(users.length);
      body.innerHTML = users.length === 0 ? `<p class="empty">가입한 유저가 없습니다.</p>` : users.map((u) => `
        <div class="card row" style="justify-content:space-between">
          <div>
            <div class="title" style="color:${u.blocked || u.dormant ? "var(--danger)" : "var(--ink)"}">${esc(u.name)} ${u.blocked ? "· 차단됨" : ""} ${u.dormant ? "· 휴면(신고 누적)" : ""}</div>
            <div class="meta">잔액 ${won(u.balance)} · 상품 ${u.product_count}개 · 피신고 ${u.report_count}건 · 가입 ${esc(u.created_at.slice(0, 10))}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${u.dormant ? `<button class="btn sm ghost" data-d="${u.id}">휴면 해제</button>` : ""}
            <button class="btn sm ${u.blocked ? "ghost" : "danger"}" data-u="${u.id}" data-b="${u.blocked ? 0 : 1}">${u.blocked ? "차단 해제" : "차단"}</button>
          </div>
        </div>`).join("");
      body.querySelectorAll("[data-u]").forEach((b) => (b.onclick = async () => {
        try { await api(`/admin/users/${b.dataset.u}/block`, { method: "POST", body: { blocked: +b.dataset.b } }); toast(+b.dataset.b ? "유저를 차단했습니다." : "차단을 해제했습니다."); load(); }
        catch (e) { toast(e.message); }
      }));
      body.querySelectorAll("[data-d]").forEach((b) => (b.onclick = async () => {
        try { await api(`/admin/users/${b.dataset.d}/dormant`, { method: "POST", body: { dormant: 0 } }); toast("휴면을 해제했습니다."); load(); }
        catch (e) { toast(e.message); }
      }));
    }

    if (S.adminSec === "products") {
      const { products } = await api("/admin/products?x=1" + PG); pager(products.length);
      body.innerHTML = products.length === 0 ? `<p class="empty">등록된 상품이 없습니다.</p>` : products.map((p) => `
        <div class="card row" style="justify-content:space-between">
          <div style="display:flex;gap:10px;align-items:center;min-width:0">
            <div class="thumb sm">${p.image ? `<img src="${esc(p.image)}" alt=""/>` : "📦"}</div>
            <div style="min-width:0">
              <div class="title" style="color:${p.status === "blocked" ? "var(--danger)" : "var(--ink)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.title)}</div>
              <div class="meta">${won(p.price)} · ${esc(p.seller_name)} · ${p.status === "active" ? "판매 중" : p.status === "sold" ? "판매완료" : "차단됨"}</div>
            </div>
          </div>
          ${p.status !== "sold" ? `<button class="btn sm ${p.status === "blocked" ? "ghost" : "danger"}" data-p="${p.id}" data-b="${p.status === "blocked" ? 0 : 1}">${p.status === "blocked" ? "복구" : "차단"}</button>` : ""}
        </div>`).join("");
      body.querySelectorAll("[data-p]").forEach((b) => (b.onclick = async () => {
        try { await api(`/admin/products/${b.dataset.p}/block`, { method: "POST", body: { blocked: +b.dataset.b } }); toast(+b.dataset.b ? "상품을 차단했습니다." : "상품을 복구했습니다."); load(); }
        catch (e) { toast(e.message); }
      }));
    }

    if (S.adminSec === "orders") {
      const { orders } = await api("/admin/orders?x=1" + PG); pager(orders.length);
      body.innerHTML = orders.length === 0 ? `<p class="empty">주문이 없습니다.</p>` : orders.map((o) => `
        <div class="card row" style="justify-content:space-between">
          <div>
            <div class="title">${esc(o.product_title)} · ${won(o.amount)}</div>
            <div class="meta">${esc(o.buyer_name)} → ${esc(o.seller_name)} · <span class="badge ${o.status === "paid" ? "" : o.status === "completed" ? "ok" : "danger"}">${{ paid: "에스크로 보관", completed: "완료", refunded: "환불됨" }[o.status]}</span> · ${esc(o.created_at)}</div>
          </div>
          ${o.status === "paid" ? `<button class="btn sm danger" data-o="${o.id}">환불</button>` : ""}
        </div>`).join("");
      body.querySelectorAll("[data-o]").forEach((b) => (b.onclick = async () => {
        if (!confirm("이 주문을 구매자에게 환불할까요? 상품은 다시 판매 중으로 전환됩니다.")) return;
        try { await api(`/admin/orders/${b.dataset.o}/refund`, { method: "POST" }); toast("환불 처리했습니다."); load(); } catch (e) { toast(e.message); }
      }));
    }

    if (S.adminSec === "transactions") {
      const { transactions } = await api("/admin/transactions?x=1" + PG); pager(transactions.length);
      body.innerHTML = transactions.length === 0 ? `<p class="empty">거래 내역이 없습니다.</p>` : transactions.map((t) => `
        <div class="card" style="padding:12px">
          <div class="title" style="font-size:13px">${esc(t.from_name || "외부/에스크로")} → ${esc(t.to_name || "에스크로")} · ${won(t.amount)}</div>
          <div class="meta">${esc(t.memo)} · ${esc(t.created_at)}</div>
        </div>`).join("");
    }
  };
  await load();
}

/* ── 토스 결제 리다이렉트 처리 ── */
(async function handlePaymentRedirect() {
  if (location.pathname === "/payment/success") {
    const q = new URLSearchParams(location.search);
    try {
      await api("/payments/charges/toss-confirm", {
        method: "POST",
        body: { paymentKey: q.get("paymentKey"), orderId: q.get("orderId"), amount: q.get("amount") },
      });
      history.replaceState(null, "", "/");
      S.view = { name: "wallet" }; S.tab = "wallet";
      toast("충전이 완료되었습니다!");
    } catch (e) {
      history.replaceState(null, "", "/");
      toast(e.message);
    }
  } else if (location.pathname === "/payment/fail") {
    history.replaceState(null, "", "/");
    toast("결제가 취소되었거나 실패했습니다.");
  }
  render();
})();
