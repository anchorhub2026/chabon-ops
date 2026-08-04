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
  } else if (data.type === "saveShiftConfig") {
    handleSaveShiftConfig(ss, data);
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

// 「確定プラン」シートの全行を、analytics.htmlの「過去の確定プラン履歴」表示用に返す。
// 「日付」列はDate型（自動変換済み）と"M/D"形式の文字列が混在しうる。文字列の場合は年情報が
// 無いため、同じ行の「確定日時」（実際にconfirmPlanが呼ばれた時刻＝本物のDate）の年を採用する
// （「今日から近い方の年」という推測ではなく、記録された実際の年を使うことで真に過去のデータでも正しく年を復元できる）。
function handleGetConfirmedPlans(ss) {
  var sheet = ss.getSheetByName("確定プラン");
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ plans: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rows = sheet.getDataRange().getValues();
  var plans = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var r = rows[i];
    var dateVal = r[0];
    var confirmedAt = r[8];
    var iso;
    if (Object.prototype.toString.call(dateVal) === '[object Date]') {
      iso = Utilities.formatDate(dateVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else {
      var parts = String(dateVal).split("/");
      var year = (Object.prototype.toString.call(confirmedAt) === '[object Date]')
        ? confirmedAt.getFullYear()
        : new Date().getFullYear();
      if (parts.length === 2) {
        var mm = ("0" + parts[0]).slice(-2);
        var dd = ("0" + parts[1]).slice(-2);
        iso = year + "-" + mm + "-" + dd;
      } else {
        iso = String(dateVal);
      }
    }
    var zuid = Number(r[2]) || 0;
    var uva = Number(r[3]) || 0;
    var chise = Number(r[4]) || 0;
    var hqQty = Number(r[6]) || 0;
    plans.push({
      date: iso,
      weekday: String(r[1] || ""),
      zuid: zuid,
      uva: uva,
      chise: chise,
      hqQty: hqQty,
      // 総生産数＝Zuid＋UvA＋チセ（本部製造数はこの内訳の一部であり、別途加算しない）
      total: zuid + uva + chise,
    });
  }
  plans.sort(function(a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return ContentService.createTextOutput(JSON.stringify({ plans: plans }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Date オブジェクト（スプレッドシートが自動変換した場合）をISO形式(yyyy-MM-dd)に正規化
// スクリプトのタイムゾーンを使うことで "2026-07-01" → Date → "2026-07-01" と正しく往復できる
function normalizeDateCell(val) {
  if (Object.prototype.toString.call(val) === '[object Date]') {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(val);
}

// 時刻セル（例：販売終了時間）はスプレッドシートが自動的にDate型に変換することがあるため、
// "HH:mm" 形式の文字列に正規化する
function normalizeTimeCell(val) {
  if (!val) return "";
  if (Object.prototype.toString.call(val) === '[object Date]') {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "HH:mm");
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

function getDraftsData(ss) {
  var sheet = ss.getSheetByName("作業中プラン");
  if (!sheet) return [];
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
  return drafts;
}

function handleGetDraft(ss) {
  return ContentService.createTextOutput(JSON.stringify({ drafts: getDraftsData(ss) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// admin.htmlで設定するシフト入力期間（開始日・終了日・土日を含めるか）を1行だけ保持する。
// 複数行になる必要がない設定なので、2行目を常に上書きする（無ければ追加）。
function handleSaveShiftConfig(ss, data) {
  var sheet = ss.getSheetByName("シフト設定");
  if (!sheet) {
    sheet = ss.insertSheet("シフト設定");
    sheet.appendRow(["開始日", "終了日", "土日を含める", "更新日時"]);
  }
  var row = [data.startDate, data.endDate, !!data.includeWeekends, new Date()];
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function getShiftConfigData(ss) {
  var sheet = ss.getSheetByName("シフト設定");
  if (!sheet || sheet.getLastRow() < 2) return null;
  var row = sheet.getRange(2, 1, 1, 3).getValues()[0];
  return {
    startDate: normalizeDateCell(row[0]),
    endDate: normalizeDateCell(row[1]),
    includeWeekends: row[2] === true,
  };
}

function handleGetShiftConfig(ss) {
  return ContentService.createTextOutput(JSON.stringify({ config: getShiftConfigData(ss) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// admin.html/index.htmlの初期表示で必要な小さめのシート（作業中プラン・具材ステータス・
// シフト設定）をまとめて1回のリクエストで返す。個別にtype=draft/status/shiftConfigを
// 呼ぶと、SpreadsheetApp.openById()のオーバーヘッドやApps Script Web Appの同時実行数を
// 呼び出し回数分だけ余分に消費してしまうため、初期表示の高速化のために統合した。
function handleGetBootstrap(ss) {
  return ContentService.createTextOutput(JSON.stringify({
    drafts: getDraftsData(ss),
    statuses: getStatusesData(ss),
    shiftConfig: getShiftConfigData(ss),
  })).setMimeType(ContentService.MimeType.JSON);
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
  "販売終了時間", "備考", "あげた数",
  "12時ランチ", "12時スタンプ", "13時ランチ", "13時スタンプ", "14時ランチ", "14時スタンプ",
  "15時ランチ", "15時スタンプ", "16時ランチ", "16時スタンプ", "17時ランチ", "17時スタンプ",
  "18時ランチ", "18時スタンプ",
  "12時あげた数", "13時あげた数", "14時あげた数", "15時あげた数", "16時あげた数", "17時あげた数", "18時あげた数"];
// 「あげた数」列（単一）・「〇時ランチ」「〇時スタンプ」列は、時間帯ごとの
// 「〇時あげた数」列（ランチ・スタンプ統合）に置き換えられたため以後は書き込まない
// （既存行の後方互換のため列自体は残す。過去データの読み取り時はgetHourlySheetRowsで
// 　新列が空なら旧ランチ・スタンプ列の合計にフォールバックする）

// 各時間帯残数と、その時間帯の「あげた数」から、時間帯ごとの売れた数・累計売上を算出する。
// あげた数はその時間帯で実際に減った分から除外し、「純粋な販売数」を算出する。
// 売れた数[i] = (i==0 ? 作った数 : 直前の残数) - 残数[i] - あげた数[i]
//              （残数の前後どちらかが未入力なら空欄）
// 累計売上[i] = 作った数 - 残数[i] - (0〜iのあげた数の累計)（残数が未入力なら空欄）
function calcHourlySoldAndCumulative(made, remains, givens) {
  var sold = [];
  var cumulative = [];
  var prev = made;
  var givenSum = 0;
  for (var i = 0; i < remains.length; i++) {
    var curr = remains[i];
    var hasCurr = curr !== "" && curr !== null && curr !== undefined;
    var hasPrev = prev !== "" && prev !== null && prev !== undefined;
    var given = Number(givens[i] || 0);
    sold.push(hasCurr && hasPrev ? (Number(prev) - Number(curr) - given) : "");
    givenSum += given;
    var hasMade = made !== "" && made !== null && made !== undefined;
    cumulative.push(hasCurr && hasMade ? (Number(made) - Number(curr) - givenSum) : "");
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
      var givens = [item.given12, item.given13, item.given14, item.given15, item.given16, item.given17, item.given18]
        .map(function(v) { return Number(v || 0); });
      var calc = calcHourlySoldAndCumulative(item.total, remains, givens);
      var row = [
        data.date, data.weekday, data.weather, data.temp,
        storeData.store, storeData.location,
        item.filling, item.total,
        remains[0], remains[1], remains[2], remains[3], remains[4], remains[5], remains[6],
        calc.sold[0], calc.sold[1], calc.sold[2], calc.sold[3], calc.sold[4], calc.sold[5], calc.sold[6],
        calc.cumulative[0], calc.cumulative[1], calc.cumulative[2], calc.cumulative[3], calc.cumulative[4], calc.cumulative[5], calc.cumulative[6],
        storeData.soldOutTime || "",
        storeData.note || "",
        "", // あげた数（単一・廃止、後方互換のため列のみ維持）
        "", "", "", "", "", "", "", "", "", "", "", "", "", "", // 〇時ランチ・〇時スタンプ（廃止、後方互換のため列のみ維持）
        givens[0], givens[1], givens[2], givens[3], givens[4], givens[5], givens[6]
      ];
      if (foundRow > 0) {
        sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
      } else {
        sheet.appendRow(row);
      }
    });
  });
}

function getStatusesData(ss) {
  var sheet = ss.getSheetByName("具材ステータス");
  if (!sheet) return [];
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
  return statuses;
}

function handleGetStatus(ss) {
  return ContentService.createTextOutput(JSON.stringify({ statuses: getStatusesData(ss) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 新形式の「〇時あげた数」の値があればそれを使い、空（未入力）の場合のみ
// 旧形式の「〇時ランチ」＋「〇時スタンプ」の合計にフォールバックする
function givenOrLegacySum(newVal, legacyLunch, legacyStamp) {
  if (newVal !== "") return newVal;
  var lunch = (legacyLunch !== "" && legacyLunch !== null && legacyLunch !== undefined) ? Number(legacyLunch) : 0;
  var stamp = (legacyStamp !== "" && legacyStamp !== null && legacyStamp !== undefined) ? Number(legacyStamp) : 0;
  return (lunch || stamp) ? (lunch + stamp) : "";
}

// 「時間帯別実績」シートの行を読み取り、日付・曜日・天気・気温を含む
// フルフィールドのオブジェクト配列として返す（handleGetHourly / handleGetAnalytics 共通）。
// dateFilter（yyyy-MM-dd）を指定すると、実績シートの行数が増えても影響を受けにくいよう
// まずA列（日付）だけを読んで該当行番号を特定し、一致した行だけを読み込む。
// dateFilterを指定しない場合（analytics.html向け）は従来通り全行を読み取る。
function getHourlySheetRows(ss, dateFilter) {
  var sheet = ss.getSheetByName("時間帯別実績");
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), HOURLY_SHEET_HEADER.length);

  var dataRows;
  if (dateFilter) {
    var dateCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var matchedRowNumbers = [];
    for (var i = 0; i < dateCol.length; i++) {
      if (dateCol[i][0] && normalizeDateCell(dateCol[i][0]) === dateFilter) matchedRowNumbers.push(i + 2);
    }
    dataRows = matchedRowNumbers.map(function(rowNum) {
      return sheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
    });
  } else {
    dataRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  }

  var result = [];
  for (var j = 0; j < dataRows.length; j++) {
    if (!dataRows[j][0]) continue;
    var r = dataRows[j];
    var v = function(idx) { return r[idx] !== "" && r[idx] !== null && r[idx] !== undefined ? r[idx] : ""; };
    result.push({
      date:        normalizeDateCell(r[0]),
      weekday:     String(r[1] || ""),
      weather:     String(r[2] || ""),
      temp:        v(3),
      store:       String(r[4] || ""),
      location:    String(r[5] || ""),
      filling:     String(r[6] || ""),
      total:       v(7),
      r12:         v(8),  r13: v(9),  r14: v(10), r15: v(11), r16: v(12), r17: v(13), r18: v(14),
      sold12:      v(15), sold13: v(16), sold14: v(17), sold15: v(18), sold16: v(19), sold17: v(20), sold18: v(21),
      cum12:       v(22), cum13:  v(23), cum14:  v(24), cum15:  v(25), cum16:  v(26), cum17:  v(27), cum18:  v(28),
      soldOutTime: normalizeTimeCell(r[29]),
      note:        String(r[30] || ""),
      given:       v(31),
      lunch12:     v(32), stamp12: v(33), lunch13: v(34), stamp13: v(35),
      lunch14:     v(36), stamp14: v(37), lunch15: v(38), stamp15: v(39),
      lunch16:     v(40), stamp16: v(41), lunch17: v(42), stamp17: v(43),
      lunch18:     v(44), stamp18: v(45),
      // 新形式の「〇時あげた数」（v(46)〜v(52)）が空の古い行は、
      // 旧形式の「〇時ランチ」＋「〇時スタンプ」の合計にフォールバックする
      given12: givenOrLegacySum(v(46), r[32], r[33]),
      given13: givenOrLegacySum(v(47), r[34], r[35]),
      given14: givenOrLegacySum(v(48), r[36], r[37]),
      given15: givenOrLegacySum(v(49), r[38], r[39]),
      given16: givenOrLegacySum(v(50), r[40], r[41]),
      given17: givenOrLegacySum(v(51), r[42], r[43]),
      given18: givenOrLegacySum(v(52), r[44], r[45]),
    });
  }
  return result;
}

function handleGetHourly(ss, dateFilter) {
  return ContentService.createTextOutput(JSON.stringify({ rows: getHourlySheetRows(ss, dateFilter) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// データ分析ページ（analytics.html）向け。時間帯別実績の全行を
// 日付・曜日・天気・気温を含む形で返す
function handleGetAnalytics(ss) {
  return ContentService.createTextOutput(JSON.stringify({ rows: getHourlySheetRows(ss) }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (e.parameter && e.parameter.type === "disruptions") {
    return handleDisruptions();
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);

  if (e.parameter && e.parameter.type === "bootstrap") {
    return handleGetBootstrap(ss);
  }

  if (e.parameter && e.parameter.type === "draft") {
    return handleGetDraft(ss);
  }

  if (e.parameter && e.parameter.type === "status") {
    return handleGetStatus(ss);
  }

  if (e.parameter && e.parameter.type === "hourly") {
    // dateパラメータ（yyyy-MM-dd）が指定された場合はその日付の行だけを返す。
    // 実績シートは行数が増え続けるため、当日分の表示だけが目的のindex.htmlは
    // dateを指定して読み取り範囲を絞る（analytics.htmlは全件が必要なので指定しない）
    return handleGetHourly(ss, e.parameter.date);
  }

  if (e.parameter && e.parameter.type === "analytics") {
    return handleGetAnalytics(ss);
  }

  if (e.parameter && e.parameter.type === "shiftConfig") {
    return handleGetShiftConfig(ss);
  }

  if (e.parameter && e.parameter.type === "confirmedPlans") {
    return handleGetConfirmedPlans(ss);
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
