// app.js
// Kết nối Socket.IO tới wss://api-redsell.gpttrade.app và hiển thị trên trình duyệt

// TODO: Nếu token hết hạn, bạn cần thay token mới vào đây
// Lưu ý: KHÔNG để cả "/socket.io/..." trong URL truyền vào io(),
// nếu không server có thể báo "Invalid namespace".
const BASE_URL = "wss://api-redsell.gpttrade.app";
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NjYwNDM3MzcsIm5pY2tOYW1lIjoiQmVlbnlldCIsImlkIjoiZDM4NDIzNmYtNjQ5Ny00NjUxLWEzNzMtMDNmMDY4YWE2MGI4IiwiZW1haWwiOiJwaHVuZ3RoYW5obG9uZzA4QGdtYWlsLmNvbSIsInNjb3BlIjoiIiwiZXhwIjoxNzY2MTMwMTM3LCJhdWQiOiJodHRwczovL2dwdHRyYWRlLmFwcC8iLCJpc3MiOiJncHR0cmFkZS1yZWRzZWxsIiwic3ViIjoiaW5mb0BncHR0cmFkZS5hcHAifQ.AL0qtxotXMDR_9FhZfyMqgW12-JO_rNgxytKSKeph8I";

// Kết nối tới namespace mặc định "/", path chuẩn của Socket.IO là "/socket.io"
const socket = io(BASE_URL, {
  path: "/socket.io", // rất quan trọng với Socket.IO server, tránh lỗi Invalid namespace
  transports: ["websocket"], // ép dùng websocket
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  query: {
    token: TOKEN,
  },
});

// Lưu 10 message JSON gần nhất (chỉ để debug khi cần)
const lastMessages = [];
const MAX_MESSAGES = 10;

// Lưu session hiện tại (từ CURRENT_SESSION)
let currentSessionId = null;
let lastPrintedSessionId = null; // có thể dùng nếu sau này cần tránh in trùng
let lastSecondShown = null;
// Lưu trạng thái ss_t hiện tại cho từng session (TRADE / WAIT)
const sessionState = {};
// Đánh dấu đã in summary cho từng session + trạng thái (để không log spam)
// { [sessionId]: { WAIT: boolean, TRADE: boolean } }
const summaryShown = {};

// Lưu phân tích AI theo sessionId (luôn cập nhật mới nhất)
// { [sessionId]: { trend: { betType, ratio }, liquidity: {...}, news: {...} } }
const aiBySession = {};
// Snapshot AI tại thời điểm WAIT để dùng cố định cho việc thống kê & kết quả (không bị thay đổi về sau)
const aiSnapshotAtWait = {};

// Đánh dấu phiên nào đã tính kết quả (dựa trên ADD_CLOSE_ORDER)
const sessionResultDone = new Set();

// Thống kê win/loss theo từng bot (tạm thời chưa có event kết quả nên để 0)
const botStats = {
  trend: { win: 0, loss: 0 },
  liquidity: { win: 0, loss: 0 },
  news: { win: 0, loss: 0 },
};

// Lưu lịch sử kết quả của từng bot (tối đa 10 kết quả gần nhất)
const botResults = {
  trend: [],
  liquidity: [],
  news: [],
};

// DOM elements
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const countdownEl = document.getElementById("countdown");
const botCards = document.getElementById("botCards");
const logContainer = document.getElementById("logContainer");

// Format bot name thành Title Case
function formatBotName(botName) {
  return botName.charAt(0).toUpperCase() + botName.slice(1);
}

function addMessage(eventName, data) {
  const record = {
    time: new Date().toISOString(),
    event: eventName,
    data,
  };

  lastMessages.push(record);
  if (lastMessages.length > MAX_MESSAGES) {
    lastMessages.shift(); // bỏ bản ghi cũ nhất
  }
}

// Thêm log vào DOM
function addLog(message, type = "info") {
  const logEntry = document.createElement("div");
  logEntry.className = "log-entry";
  
  const time = new Date().toLocaleTimeString("vi-VN");
  logEntry.innerHTML = `<span class="log-time">[${time}]</span>${message}`;
  
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
  
  // Giới hạn số lượng log để tránh lag
  while (logContainer.children.length > 100) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

// Hiển thị thống kê bot trên UI
function updateBotCards(sessionId, stateLabel) {
  // Ưu tiên dùng snapshot ở thời điểm WAIT, nếu chưa có thì fallback về dữ liệu mới nhất
  const ai = aiSnapshotAtWait[sessionId] || aiBySession[sessionId];
  if (!ai) return;

  botCards.innerHTML = "";

  ["trend", "liquidity", "news"].forEach((botName) => {
    const signal = ai[botName];
    if (!signal) return;

    // Hiển thị hướng thân thiện: UP -> BUY, DOWN -> SELL
    let humanDir = signal.betType;
    if (signal.betType === "UP") humanDir = "BUY";
    else if (signal.betType === "DOWN") humanDir = "SELL";

    const stat = botStats[botName] || { win: 0, loss: 0 };
    const total = stat.win + stat.loss;
    const winRate = total ? ((stat.win / total) * 100).toFixed(2) : "0.00";

    // Tín hiệu tỉ lệ cao (> 75%) sẽ được thêm class để đổi màu (text xanh)
    const isHighRatio = Number(signal.ratio) > 75;
    const signalClass = isHighRatio ? "signal signal-high" : "signal";

    // Win Rate trong phần bot-info: trên 50% xanh, 50% trở xuống đỏ
    const isHighWinRate = Number(winRate) > 50;
    const winRateClass = isHighWinRate ? "ratio-high" : "ratio-low";

    // Lấy lịch sử kết quả của bot này
    const results = botResults[botName] || [];
    let resultsHtml = "";
    if (results.length > 0) {
      resultsHtml = '<div class="bot-results">';
      results.slice(-10).reverse().forEach(r => {
        const shortSessionId =
          r.sessionId.length > 8 ? r.sessionId.substring(0, 8) + "..." : r.sessionId;
        const resultClass = r.result === "WIN" ? "win" : "loss";
        resultsHtml += `<div class="${resultClass}">${shortSessionId}: ${r.result} (${r.prediction} ${r.ratio}%)</div>`;
      });
      resultsHtml += "</div>";
    }

    const botCard = document.createElement("div");
    botCard.className = "bot-card";
    
    botCard.innerHTML = `
      <div class="bot-name">${formatBotName(botName)}</div>
      <div class="bot-info">
        <div>Win/Loss: ${stat.win}/${stat.loss}</div>
        <div class="${winRateClass}">Win Rate: ${winRate}%</div>
        <div>Ratio: ${signal.ratio}%</div>
      </div>
      <div class="${signalClass}">${humanDir} - ${signal.ratio}%</div>
      ${resultsHtml}
    `;
    
    botCards.appendChild(botCard);
  });
}

// In thống kê theo format bạn yêu cầu cho 1 session cụ thể (vẫn log vào console)
function printSessionSummary(sessionId, stateLabel) {
  // Ưu tiên dùng snapshot ở thời điểm WAIT, nếu chưa có thì fallback về dữ liệu mới nhất
  const ai = aiSnapshotAtWait[sessionId] || aiBySession[sessionId];
  if (!ai) return;

  addLog(`Session ${sessionId} - ${stateLabel || ""}`, "info");

  ["trend", "liquidity", "news"].forEach((botName) => {
    const signal = ai[botName];
    if (!signal) return;

    // Hiển thị hướng thân thiện: UP -> BUY, DOWN -> SELL
    let humanDir = signal.betType;
    if (signal.betType === "UP") humanDir = "BUY";
    else if (signal.betType === "DOWN") humanDir = "SELL";

    const stat = botStats[botName] || { win: 0, loss: 0 };
    const total = stat.win + stat.loss;
    const winRate = total ? ((stat.win / total) * 100).toFixed(2) : "0.00";

    addLog(`Bot ${formatBotName(botName)}: ${stat.win}/${stat.loss} (${winRate}%) - ${humanDir} ${signal.ratio}%`, "info");
  });

  // Cập nhật UI
  updateBotCards(sessionId, stateLabel);
}

// Hiển thị countdown trên UI (thay vì process.stdout.write)
function showCountdown(data) {
  if (!data || typeof data.r_second !== "number") return;
  const sec = data.r_second;
  if (lastSecondShown === sec) return;
  lastSecondShown = sec;

  const status = data.ss_t || "";
  const msg = `Session ${data.ss_id} - ${status} - ${sec}s remaining`;
  countdownEl.textContent = msg;
}

// Sự kiện kết nối cơ bản
socket.on("connect", () => {
  addLog(`Connected, socket id: ${socket.id}`, "info");
  statusIndicator.classList.add("connected");
  statusText.textContent = "Connected";

  // Sau khi connect xong, client cần "đăng ký" (subscribe) các kênh mà server hỗ trợ
  // theo như bạn thấy trong log: LINK_ACCOUNT_SUBCRIBE, CURRENT_SESSION_SUBCRIBE, AI_TRADING_SUBCRIBE
  // Nếu server yêu cầu thêm dữ liệu (vd: userId, sessionId,...) bạn có thể truyền trong object phía sau.

  // Theo log từ web, LINK_ACCOUNT_SUBCRIBE cần truyền thêm linkAccountId
  // Nếu bạn có nhiều tài khoản, nhớ thay đúng ID tương ứng
  socket.emit("LINK_ACCOUNT_SUBCRIBE", "2134da88-78be-4bb4-9fd3-016c04989dd7");
  socket.emit("CURRENT_SESSION_SUBCRIBE");
  socket.emit("AI_TRADING_SUBCRIBE");

  addLog("Sent 3 subscribe events", "info");
});

socket.on("connect_error", (err) => {
  addLog(`Connection error: ${err.message || err}`, "info");
  statusIndicator.classList.remove("connected");
  statusText.textContent = "Connection Error";
});

socket.on("disconnect", (reason) => {
  addLog(`Disconnected: ${reason}`, "info");
  statusIndicator.classList.remove("connected");
  statusText.textContent = "Disconnected";
});

// Để debug: log tên event lần đầu tiên xuất hiện
const seenEvents = new Set();

// Bắt tất cả event và log lại
socket.onAny((event, ...args) => {
  let data = args[0];

  // Cố gắng parse JSON nếu là string
  try {
    if (typeof data === "string") {
      data = JSON.parse(data);
    }
  } catch (e) {
    // nếu không parse được thì giữ nguyên
  }

  // Nếu là AI_ANALYZE thì lưu theo sessionId và in theo format yêu cầu (nhưng chỉ 1 lần / state)
  if (event === "AI_ANALYZE" && data && Array.isArray(data.allAiSinals)) {
    // Một số log dùng sessionId khác với sessionId trong allAiSinals, ưu tiên lấy trong allAiSinals
    const firstSignal = data.allAiSinals[0];
    const logicalSessionId =
      firstSignal && firstSignal.sessionId ? String(firstSignal.sessionId) : String(data.sessionId);
    const sessionId = logicalSessionId;

    aiBySession[sessionId] = aiBySession[sessionId] || {};

    for (const s of data.allAiSinals) {
      if (!s || !s.name) continue;
      aiBySession[sessionId][s.name] = {
        betType: s.betType,
        ratio: s.ratio,
      };
    }

    const state = sessionState[sessionId] || sessionState[currentSessionId] || "";

    // Nếu đang WAIT, lưu snapshot tại WAIT để dùng cho kết quả sau này
    if (state === "WAIT") {
      aiSnapshotAtWait[sessionId] = JSON.parse(JSON.stringify(aiBySession[sessionId]));
    }

    // Chỉ in 1 lần cho mỗi (session, state) để tránh log liên tục
    if (state === "WAIT" || state === "TRADE") {
      summaryShown[sessionId] = summaryShown[sessionId] || { WAIT: false, TRADE: false };
      if (!summaryShown[sessionId][state]) {
        summaryShown[sessionId][state] = true;
        printSessionSummary(sessionId, state);
      }
    }
  }

  // Nếu là CURRENT_SESSION thì cập nhật session hiện tại, countdown,
  // và lưu trạng thái ss_t (TRADE/WAIT). Việc in tóm tắt sẽ được kích hoạt
  // bởi AI_ANALYZE khi ss_t đang là WAIT.
  if (event === "CURRENT_SESSION" && data && data.ss_id) {
    const ssId = data.ss_id;
    currentSessionId = ssId;
    sessionState[ssId] = data.ss_t;

    if (lastPrintedSessionId !== ssId) {
      lastSecondShown = null; // reset countdown cho phiên mới
    }

    // Cập nhật countdown theo từng giây của phiên hiện tại
    showCountdown(data);
  }

  // Khi nhận ADD_CLOSE_ORDER: dùng result + betType để suy ra hướng thực tế của phiên
  if (event === "ADD_CLOSE_ORDER" && data && data.sessionId && data.result && data.betType) {
    const sessionId = String(data.sessionId);
    if (sessionResultDone.has(sessionId)) {
      addMessage(event, data);
      return;
    }

    let realDir = null;
    if (data.result === "WIN") {
      realDir = data.betType; // thắng theo đúng hướng đã đặt
    } else if (data.result === "LOSE") {
      realDir = data.betType === "UP" ? "DOWN" : "UP"; // thua nghĩa là giá đi ngược
    }

    if (!realDir) {
      addMessage(event, data);
      return;
    }

    // Dùng snapshot tại WAIT để kết quả khớp với tỉ lệ đã hiển thị lúc vào lệnh
    const ai = aiSnapshotAtWait[sessionId] || aiBySession[sessionId];
    if (!ai) {
      addMessage(event, data);
      return;
    }

    sessionResultDone.add(sessionId);

    // Hiển thị hướng thân thiện cho thực tế và lệnh
    const realDirHuman = realDir === "UP" ? "BUY" : realDir === "DOWN" ? "SELL" : realDir;
    const betDirHuman =
      data.betType === "UP" ? "BUY" : data.betType === "DOWN" ? "SELL" : data.betType;

    addLog(`SESSION RESULT ${sessionId}: ${realDirHuman} (${data.result})`, "info");

    ["trend", "liquidity", "news"].forEach((botName) => {
      const signal = ai[botName];
      if (!signal) return;

      const stat = botStats[botName];
      if (!stat) return;

      const signalHuman =
        signal.betType === "UP" ? "BUY" : signal.betType === "DOWN" ? "SELL" : signal.betType;

      // Kiểm tra bot này có đúng không
      const isWin = signal.betType === realDir;
      
      if (isWin) {
        stat.win += 1;
      } else {
        stat.loss += 1;
      }

      const total = stat.win + stat.loss;
      const winRate = total ? ((stat.win / total) * 100).toFixed(2) : "0.00";

      // Lưu kết quả vào lịch sử của bot này
      if (!botResults[botName]) {
        botResults[botName] = [];
      }
      botResults[botName].push({
        sessionId: sessionId,
        result: isWin ? "WIN" : "LOSS",
        prediction: signalHuman,
        ratio: signal.ratio,
        actual: realDirHuman
      });
      
      // Giới hạn tối đa 10 kết quả gần nhất
      if (botResults[botName].length > 10) {
        botResults[botName].shift();
      }

      addLog(`Bot ${formatBotName(botName)}: ${stat.win}/${stat.loss} (${winRate}%) - Prediction: ${signalHuman} ${signal.ratio}%`, "info");
    });

    // Cập nhật lại bot cards với thống kê mới
    updateBotCards(sessionId, sessionState[sessionId] || "");
  }

  // Log thử các event mới (chỉ 1 lần / event name) để xem server đang gửi gì
  if (!seenEvents.has(event)) {
    seenEvents.add(event);
    addLog(`New event: ${event}`, "info");
  }

  addMessage(event, data);
});

