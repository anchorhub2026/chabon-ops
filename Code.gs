var SHEET_ID = "1PHf1o3smqIQdeFkhBHjBZUEub7VtRcynQLllmSR7w-s";

// NS Reisinformatie API（運休・ストライキ情報）。NS APIポータルで取得したキーをここに設定する
var NS_API_KEY = "";

function doPost(e) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var data = JSON.parse(e.postData.contents);

  if (data.type === "confirmPlan") {
    handleConfirmPlan(ss, data);
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
    sheet.appendRow(["送信日時", "名前", "日付", "曜日", "個数", "備考"]);
  }
  for (var i = 0; i < data.entries.length; i++) {
    var entry = data.entries[i];
    sheet.appendRow([new Date(), data.name, entry.date, entry.day, entry.count, data.note]);
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
      if (String(values[r][0]) === String(day.date)) {
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

function doGet(e) {
  if (e.parameter && e.parameter.type === "disruptions") {
    return handleDisruptions();
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
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
