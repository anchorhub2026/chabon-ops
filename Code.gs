var SHEET_ID = "1PHf1o3smqIQdeFkhBHjBZUEub7VtRcynQLllmSR7w-s";

// NS Reisinformatie API（運休・ストライキ情報）。NS APIポータルで取得したキーをここに設定する
var NS_API_KEY = "";

function doPost(e) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var data = JSON.parse(e.postData.contents);

  if (data.type === "confirmPlan") {
    handleConfirmPlan(ss, data);
  } else if (data.type === "saveDraft") {
    handleSaveDraft(ss, data);
  } else if (data.type === "saveStatus") {
    handleSaveStatus(ss, data);
  } else if (data.type === "saveActual") {
    handleSaveActual(ss, data);
  } else if (data.type === "saveHourly") {
    handleSaveHourly(ss, data);
  } else {
    // type が無い場合（旧バージョンのshift.html等）もシフト回答として扱う
    handleShiftSubmit(ss, data);
  }

  return ContentService.createTextOutput('{"status":"ok"}').setMimeType(ContentService.MimeType.JSON);
}

function handleShiftSubmit(ss, data) {
  var sheet = ss.getSheetByName("シフト回答");
  if (!sheet) {
    sheet = ss.insertSheet("シフト回答");
    sheet.appendRow(["送信日時", "名前", "日付", "曜日", "個数", "備考", "必要物品"]);
  }
  for (var i = 0; i < data.entries.length; i++) {
    var entry = data.entries[i];
    sheet.appendRow([new Date(), data.name, entry.date, entry.day, entry.count, data.note || "", data.supplies || ""]);
  }
}

function handleConfirmPlan(ss, data) {
  var headers = ["日付", "曜日", "Zuid確定数", "UvA確定数", "チセ分", "ニギニギ隊内訳", "本部製造数", "本部内訳", "確定日時"];
  var sheet = ss.getSheetByName("確定プラン");
  if (!sheet) {
    sheet = ss.insertSheet("確定プラン");
    sheet.appendRow(headers);
  } else {
    // 旧バージョン（列数が少ない）のシートはヘッダーを新しい列構成に揃える
    var currentHeader = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (currentHeader[5] !== headers[5]) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  var values = sheet.getDataRange().getValues();
  var ts = new Date();

  for (var i = 0; i < data.days.length; i++) {
    var day = data.days[i];
    var foundRow = -1;
    for (var r = 1; r < values.length; r++) {
      // Google Sheets が日付文字列を Date オブジェクトに自動変換する場合があるため
      // normalizeDateCell で ISO 形式に揃えてから "M/D" 形式と比較する
      var cellNorm = normalizeDateCell(values[r][0]);
      var cellMD = "";
      var parts = cellNorm.split("-");
      if (parts.length === 3) {
        cellMD = String(Number(parts[1])) + "/" + String(Number(parts[2]));
      }
      if (String(values[r][0]) === String(day.date) || cellMD === String(day.date)) {
        foundRow = r + 1;
        break;
      }
    }
    var row = [
      day.date,
      day.day,
      day.zuid,
      day.uva,
      day.chise || 0,
      day.ningiBreakdown || "",
      day.hqQty || 0,
      day.hqBreakdown || "",
      ts
    ];
    if (foundRow > 0) {
      sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  }
}

// Date オブジェクト（スプレッドシートが自動変換した場合）をISO形式(yyyy-MM-dd)に正規化
// スクリプトのタイムゾーンを使うことで "2026-07-01" → Date → "2026-07-01" と正しく往復できる
function normalizeDateCell(val) {
  if (Object.prototype.toString.call(val) === '[object Date]') {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(val);
}

function handleSaveDraft(ss, data) {
  var sheet = ss.getSheetByName("作業中プラン");
  if (!sheet) {
    sheet = ss.insertSheet("作業中プラン");
    sheet.appendRow(["日付", "forecast", "prod", "更新日時"]);
  }
  var values = sheet.getDataRange().getValues();
  var foundRow = -1;
  var normalizedTarget = String(data.date);
  for (var r = 1; r < values.length; r++) {
    var cellStr = normalizeDateCell(values[r][0]);
    if (cellStr === normalizedTarget) {
      foundRow = r + 1;
      break;
    }
  }
  var row = [
    data.date,
    JSON.stringify(data.forecast || {}),
    JSON.stringify(data.prod || {}),
    new Date()
  ];
  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, 4).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function handleGetDraft(ss) {
  var sheet = ss.getSheetByName("作業中プラン");
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ drafts: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rows = sheet.getDataRange().getValues();
  var drafts = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    try {
      drafts.push({
        date: normalizeDateCell(rows[i][0]),
        forecast: JSON.parse(rows[i][1] || "{}"),
        prod: JSON.parse(rows[i][2] || "{}"),
      });
    } catch (err) {}
  }
  return ContentService.createTextOutput(JSON.stringify({ drafts: drafts }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleSaveStatus(ss, data) {
  var sheet = ss.getSheetByName("具材ステータス");
  if (!sheet) {
    sheet = ss.insertSheet("具材ステータス");
    sheet.appendRow(["日付", "メンバー", "具材", "具材渡し済み", "調理済み", "更新日時"]);
  }
  var values = sheet.getDataRange().getValues();
  var foundRow = -1;
  for (var r = 1; r < values.length; r++) {
    if (normalizeDateCell(values[r][0]) === String(data.date) &&
        String(values[r][1]) === String(data.member) &&
        String(values[r][2]) === String(data.filling)) {
      foundRow = r + 1;
      break;
    }
  }
  var row = [data.date, data.member, data.filling, !!data.handed, !!data.cooked, new Date()];
  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, 6).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function handleSaveActual(ss, data) {
  var sheet = ss.getSheetByName("販売実績");
  if (!sheet) {
    sheet = ss.insertSheet("販売実績");
    sheet.appendRow(["日付", "具材", "確定数", "完売時刻", "残り個数", "記録日時"]);
  }
  var values = sheet.getDataRange().getValues();
  var ts = new Date();
  (data.items || []).forEach(function(item) {
    var foundRow = -1;
    for (var r = 1; r < values.length; r++) {
      if (normalizeDateCell(values[r][0]) === String(data.date) && String(values[r][1]) === String(item.filling)) {
        foundRow = r + 1;
        break;
      }
    }
    var row = [data.date, item.filling, item.total, item.soldOutTime || "", item.remaining || 0, ts];
    if (foundRow > 0) {
      sheet.getRange(foundRow, 1, 1, 6).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  });
}

var HOURLY_SHEET_HEADER = ["日付", "曜日", "天気", "気温", "店舗", "場所名", "具材名", "作った数",
  "12時残り", "13時残り", "14時残り", "15時残り", "16時残り", "17時残り", "18時残り",
  "12時売上", "13時売上", "14時売上", "15時売上", "16時売上", "17時売上", "18時売上",
  "12時累計", "13時累計", "14時累計", "15時累計", "16時累計", "17時累計", "18時累計",
  "販売終了時間", "備考"];

// 作った数と各時間帯残数から、時間帯ごとの売れた数・累計売上を算出する
// 売れた数[i] = (i==0 ? 作った数 : 直前の残数) - 残数[i]（前後どちらかが未入力なら空欄）
// 累計売上[i] = 作った数 - 残数[i]（残数が未入力なら空欄）
function calcHourlySoldAndCumulative(made, remains) {
  var sold = [];
  var cumulative = [];
  var prev = made;
  for (var i = 0; i < remains.length; i++) {
    var curr = remains[i];
    var hasCurr = curr !== "" && curr !== null && curr !== undefined;
    var hasPrev = prev !== "" && prev !== null && prev !== undefined;
    sold.push(hasCurr && hasPrev ? (Number(prev) - Number(curr)) : "");
    var hasMade = made !== "" && made !== null && made !== undefined;
    cumulative.push(hasCurr && hasMade ? (Number(made) - Number(curr)) : "");
    prev = curr;
  }
  return { sold: sold, cumulative: cumulative };
}

function handleSaveHourly(ss, data) {
  var sheet = ss.getSheetByName("時間帯別実績");
  if (!sheet) {
    sheet = ss.insertSheet("時間帯別実績");
    sheet.appendRow(HOURLY_SHEET_HEADER);
  } else if (sheet.getLastColumn() < HOURLY_SHEET_HEADER.length) {
    sheet.getRange(1, 1, 1, HOURLY_SHEET_HEADER.length).setValues([HOURLY_SHEET_HEADER]);
  }
  var values = sheet.getDataRange().getValues();
  (data.stores || []).forEach(function(storeData) {
    (storeData.items || []).forEach(function(item) {
      var foundRow = -1;
      for (var r = 1; r < values.length; r++) {
        if (normalizeDateCell(values[r][0]) === String(data.date) &&
            String(values[r][4]) === String(storeData.store) &&
            String(values[r][6]) === String(item.filling)) {
          foundRow = r + 1;
          break;
        }
      }
      var remains = [item.r12, item.r13, item.r14, item.r15, item.r16, item.r17, item.r18]
        .map(function(v) { return v === "" ? "" : v; });
      var calc = calcHourlySoldAndCumulative(item.total, remains);
      var row = [
        data.date, data.weekday, data.weather, data.temp,
        storeData.store, storeData.location,
        item.filling, item.total,
        remains[0], remains[1], remains[2], remains[3], remains[4], remains[5], remains[6],
        calc.sold[0], calc.sold[1], calc.sold[2], calc.sold[3], calc.sold[4], calc.sold[5], calc.sold[6],
        calc.cumulative[0], calc.cumulative[1], calc.cumulative[2], calc.cumulative[3], calc.cumulative[4], calc.cumulative[5], calc.cumulative[6],
        storeData.soldOutTime || "",
        storeData.note || ""
      ];
      if (foundRow > 0) {
        sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
      } else {
        sheet.appendRow(row);
      }
    });
  });
}

function handleGetStatus(ss) {
  var sheet = ss.getSheetByName("具材ステータス");
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ statuses: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rows = sheet.getDataRange().getValues();
  var statuses = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    statuses.push({
      date: normalizeDateCell(rows[i][0]),
      member: String(rows[i][1]),
      filling: String(rows[i][2] || ""),
      handed: rows[i][3] === true,
      cooked: rows[i][4] === true,
    });
  }
  return ContentService.createTextOutput(JSON.stringify({ statuses: statuses }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleGetHourly(ss) {
  var sheet = ss.getSheetByName("時間帯別実績");
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rows = sheet.getDataRange().getValues();
  var result = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var r = rows[i];
    var v = function(idx) { return r[idx] !== "" && r[idx] !== null && r[idx] !== undefined ? r[idx] : ""; };
    result.push({
      date:        normalizeDateCell(r[0]),
      store:       String(r[4] || ""),
      location:    String(r[5] || ""),
      filling:     String(r[6] || ""),
      total:       v(7),
      r12:         v(8),  r13: v(9),  r14: v(10), r15: v(11), r16: v(12), r17: v(13), r18: v(14),
      sold12:      v(15), sold13: v(16), sold14: v(17), sold15: v(18), sold16: v(19), sold17: v(20), sold18: v(21),
      cum12:       v(22), cum13:  v(23), cum14:  v(24), cum15:  v(25), cum16:  v(26), cum17:  v(27), cum18:  v(28),
      soldOutTime: String(r[29] || ""),
      note:        String(r[30] || ""),
    });
  }
  return ContentService.createTextOutput(JSON.stringify({ rows: result }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (e.parameter && e.parameter.type === "disruptions") {
    return handleDisruptions();
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);

  if (e.parameter && e.parameter.type === "draft") {
    return handleGetDraft(ss);
  }

  if (e.parameter && e.parameter.type === "status") {
    return handleGetStatus(ss);
  }

  if (e.parameter && e.parameter.type === "hourly") {
    return handleGetHourly(ss);
  }
  var sheet = ss.getSheetByName("シフト回答");
  if (!sheet) {
    return ContentService.createTextOutput("[]").setMimeType(ContentService.MimeType.JSON);
  }
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var result = [];
  for (var i = 1; i < rows.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i][j];
    }
    result.push(obj);
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// NSのストライキ・運休情報を取得し、日付（yyyy-MM-dd）ごとのタイトル一覧にまとめて返す。
// admin.html / index.html 側はこの結果を使って該当日に-50個補正と赤バッジを表示する。
function handleDisruptions() {
  if (!NS_API_KEY) {
    return ContentService.createTextOutput(JSON.stringify({ error: "NS_API_KEY が未設定です", disruptionsByDate: {} }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var url = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/disruptions?isActive=true";
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "Ocp-Apim-Subscription-Key": NS_API_KEY },
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "NS API エラー: HTTP " + res.getResponseCode(),
        disruptionsByDate: {}
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var data = JSON.parse(res.getContentText());
    var byDate = {};

    (data || []).forEach(function (d) {
      var title = d.title || d.topic || "運休・遅延情報";
      var spans = d.timespans || [];
      if (spans.length === 0 && d.start) {
        spans = [{ start: d.start, end: d.end }];
      }
      spans.forEach(function (span) {
        if (!span || !span.start) return;
        var startDate = new Date(span.start);
        var endDate = span.end ? new Date(span.end) : startDate;
        var cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        var last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
        while (cursor <= last) {
          var key = Utilities.formatDate(cursor, "Europe/Amsterdam", "yyyy-MM-dd");
          if (!byDate[key]) byDate[key] = [];
          if (byDate[key].indexOf(title) === -1) byDate[key].push(title);
          cursor.setDate(cursor.getDate() + 1);
        }
      });
    });

    return ContentService.createTextOutput(JSON.stringify({ disruptionsByDate: byDate }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err), disruptionsByDate: {} }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
