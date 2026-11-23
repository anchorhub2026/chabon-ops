var SHEET_ID = "1PHf1o3smqIQdeFkhBHjBZUEub7VtRcynQLllmSR7w-s";
var CHISE_SHEET_ID = "1rQtRUSP5e7qOjnT4RPvMGfWrEFcFL89AsLe8cjGIW4U"; // チセさんの生産データ

// NS Reisinformatie API（運休・ストライキ情報）。NS APIポータルで取得したキーをここに設定する
var NS_API_KEY = "";

function doPost(e) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var data = JSON.parse(e.postData.contents);

  // Zuid保存とUvA保存の同時実行や、保存ボタンの連打（多重送信）が発生した場合、
  // 「既存行を探して上書き、無ければ追加」という読み取り→書き込みの処理が並行に走ると、
  // どちらのリクエストも「見つからない」と判定して重複行を作ってしまったり、
  // 片方の書き込みが後続の読み取りに反映されず実質的にデータが失われる恐れがある。
  // これを防ぐため、書き込み処理全体をスクリプトロックで直列化する。
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // UvA学事暦・UvA学事暦設定シートは、存在しなければここで初期データ付きで作成する
    // （admin.htmlは「UvA学事暦」には書き込まないため、他のシートのように個別の保存
    // 　ハンドラ内で遅延作成できない。doPostが呼ばれるたびの軽い存在チェックで対応する）
    ensureUvaAcademicCalendarSheet(ss);
    ensureUvaAcademicCoefficientsSheet(ss);

    if (data.type === "confirmPlan") {
      handleConfirmPlan(ss, data);
    } else if (data.type === "reviseConfirmedDay") {
      handleReviseConfirmedDay(ss, data);
    } else if (data.type === "publishDays") {
      handlePublishDays(ss, data);
    } else if (data.type === "unpublishDay") {
      handleUnpublishDay(ss, data);
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
    } else if (data.type === "saveMonthlyOnigiriAssignment") {
      handleSaveMonthlyOnigiriAssignment(ss, data);
    } else if (data.type === "saveStoreSettings") {
      handleSaveStoreSettings(ss, data);
    } else if (data.type === "saveUvaAcademicCoefficient") {
      handleSaveUvaAcademicCoefficient(ss, data);
    } else {
      // type が無い場合（旧バージョンのshift.html等）もシフト回答として扱う
      handleShiftSubmit(ss, data);
    }
  } finally {
    lock.releaseLock();
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

// 確定プランシートの日付列から、dateStr（"M/D"形式）に一致する行番号（1始まり）を探す。
// Google Sheets が日付文字列を Date オブジェクトに自動変換する場合があるため、
// normalizeDateCell で ISO 形式に揃えてから "M/D" 形式と比較する。見つからなければ -1。
function findConfirmedPlanRow(values, dateStr) {
  for (var r = 1; r < values.length; r++) {
    var cellNorm = normalizeDateCell(values[r][0]);
    var cellMD = "";
    var parts = cellNorm.split("-");
    if (parts.length === 3) {
      cellMD = String(Number(parts[1])) + "/" + String(Number(parts[2]));
    }
    if (String(values[r][0]) === String(dateStr) || cellMD === String(dateStr)) {
      return r + 1;
    }
  }
  return -1;
}

// 確定プランシートのヘッダー行。Zuid内訳・UvA内訳・チセ内訳・修正日時（後から追加した列）は、
// 既存データの列位置を変えないよう末尾に追加した。過去に確定済みの行はこれらの列を
// 持たない場合があり、その場合は具材別の店舗内訳が無く合計数のみ・未修正として扱われる
// （handleGetConfirmedPlans・confirmed-plan.jsの呼び出し側で判定する）。
// Rozen確定数・Rozen内訳（14・15列目）は、Rozengracht店オープンに伴い末尾に追加した列。
// 既存の列位置・意味は一切変えていないため、これより前に確定された行はこの2列が空
// （＝Rozengracht分0個）として扱われる（handleGetConfirmedPlans参照）。
// ニギニギ隊内訳（店舗別）（16列目）は、生産割り振りで「どの店舗の分を誰が担当したか」を
// 記録するために末尾に追加した列。既存の「ニギニギ隊内訳」列（6列目、具材合計）は
// 一切変更しないため、月次支払い集計等はこの列を参照しない限り影響を受けない。
// これより前に確定された行はこの列が空（＝店舗別内訳データなし）として扱われる。
// チセ優先担当（17列目）は、その日のチセ分を最優先で担当させるメンバー（自動/YUMI/MARI/
// CHIKAKO/MIKI）を記録する列。これより前に確定された行はこの列が空（＝自動）として扱われる。
// 公開状態・公開日時（18・19列目）は、確定（ニギニギ隊への内部確定）とシフト表
// （production.html）への公開を日ごとに分けて行えるようにするために追加した列。
// 「公開」「非公開」のどちらかの文字列を入れる。これより前に確定された行（これらの列が
// 空）は、従来どおり確定＝即公開だったため「公開」として扱う（handleGetConfirmedPlans・
// production.html・confirmed-plan.jsのparseConfirmedPlansSheetで判定する）。
var CONFIRMED_PLAN_HEADERS = ["日付", "曜日", "Zuid確定数", "UvA確定数", "チセ分", "ニギニギ隊内訳", "本部製造数", "本部内訳", "確定日時", "Zuid内訳", "UvA内訳", "チセ内訳", "修正日時", "Rozen確定数", "Rozen内訳", "ニギニギ隊内訳（店舗別）", "チセ優先担当", "公開状態", "公開日時"];

function ensureConfirmedPlanSheet(ss) {
  var sheet = ss.getSheetByName("確定プラン");
  if (!sheet) {
    sheet = ss.insertSheet("確定プラン");
    sheet.appendRow(CONFIRMED_PLAN_HEADERS);
  } else {
    // 列名の変更・追加（旧バージョンの列数が少ないシートも含む）を都度反映する。
    // データ行の列位置には影響しない
    sheet.getRange(1, 1, 1, CONFIRMED_PLAN_HEADERS.length).setValues([CONFIRMED_PLAN_HEADERS]);
  }
  return sheet;
}

// 指定行（1始まり）の現在の確定日時（9列目）を、gvizの日時リテラルと比較できる文字列に
// 正規化して返す。クライアント側（fetchConfirmedPlanConfirmedAtRaw等）が読む値と
// 同じ形式にすることで、楽観的ロックの照合に使える。
function confirmedPlanRowConfirmedAtLiteral(values, rowIndex1) {
  var cell = values[rowIndex1 - 1][8];
  return cell instanceof Date ? dateToGvizLiteral(cell) : String(cell || "");
}

// 楽観的ロックのチェック：expectedConfirmedAtが指定されていて、かつ現在シート上の
// 確定日時と一致しなければ、他の端末が先に確定・修正・公開している可能性があるとみなし
// falseを返す（呼び出し側は書き込まずに中断する）。expectedConfirmedAtが無ければ常にtrue
// （チェックをスキップする）。
function checkConfirmedPlanLock(values, rowIndex1, expectedConfirmedAt) {
  if (!expectedConfirmedAt) return true;
  var current = confirmedPlanRowConfirmedAtLiteral(values, rowIndex1);
  return !current || current === String(expectedConfirmedAt);
}

function handleConfirmPlan(ss, data) {
  var sheet = ensureConfirmedPlanSheet(ss);
  var values = sheet.getDataRange().getValues();
  var ts = new Date();
  var nextAppendRow = values.length + 1; // appendRowで追加される次の行番号を追跡する

  for (var i = 0; i < data.days.length; i++) {
    var day = data.days[i];
    var foundRow = findConfirmedPlanRow(values, day.date);
    var row = [
      day.date,
      day.day,
      day.zuid,
      day.uva,
      day.chise || 0,
      day.ningiBreakdown || "",
      day.hqQty || 0,
      day.hqBreakdown || "",
      ts,
      day.zuidBreakdown || "",
      day.uvaBreakdown || "",
      day.chiseBreakdown || ""
    ];
    var targetRow;
    // 公開状態・公開日時：新規に確定した行は「確定のみ（非公開）」から始める
    // （「シフト表に公開」「まとめて公開」を押すまでproduction.htmlには表示されない）。
    // 既に行があるのにこの経路（確定のみ）が呼ばれた場合は、既存の公開状態を変えない
    // （「確定のみ」の操作で、既に公開済みの日を黙って非公開に戻してしまわないため）。
    var publishState = "非公開";
    var publishedAt = "";
    if (foundRow > 0) {
      publishState = String(values[foundRow - 1][17] || "非公開");
      publishedAt = values[foundRow - 1][18] || "";
      // 「修正日時」列（13列目）には触れない。週単位の確定（新規確定・まだ修正されていない日の
      // 再送）はここに値を書き込まないことで、「修正済み」バッジは本当に修正操作が行われた
      // 日にだけ表示されるようにする
      sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
      targetRow = foundRow;
    } else {
      sheet.appendRow(row);
      targetRow = nextAppendRow;
      nextAppendRow++;
    }
    // Rozen確定数・Rozen内訳（14・15列目）は「修正日時」のような特別な保護を持たないため、
    // 新規確定・再送のどちらでも常に最新の値に上書きする
    sheet.getRange(targetRow, 14, 1, 2).setValues([[day.rozen || 0, day.rozenBreakdown || ""]]);
    // ニギニギ隊内訳（店舗別）（16列目）・チセ優先担当（17列目）も同様に常に最新の値へ上書きする
    sheet.getRange(targetRow, 16, 1, 2).setValues([[day.ningiBreakdownByStore || "", day.chisePriorityAssignee || "自動"]]);
    sheet.getRange(targetRow, 18, 1, 2).setValues([[publishState, publishedAt]]);
  }
}

// 確定済みの1日分だけを、admin.htmlの「この日を修正する」→「修正を確定」から更新する。
// 週単位のhandleConfirmPlanとは違い対象は1行だけで、かつ楽観的ロックを必須で確認する
// （確定日時が読み込み時点から変わっていれば、他の端末が先に確定・修正している可能性があるため
// 書き込まずに中断する＝「確定済みの日を自動の処理や競合した保存で書き換えない」の延長）。
// 公開状態・公開日時（18・19列目）は変更しない（修正前の値をそのまま書き戻す）：
// 公開中の日を修正すれば内容がそのままproduction.htmlに反映され、非公開の日を修正しても
// 非公開のままになる。
function handleReviseConfirmedDay(ss, data) {
  var sheet = ss.getSheetByName("確定プラン");
  if (!sheet) return; // 確定プランシート自体が無い＝修正対象の確定行も無い

  var values = sheet.getDataRange().getValues();
  var foundRow = findConfirmedPlanRow(values, data.date);
  if (foundRow === -1) return; // 修正対象の確定行が見つからない（通常は起こらない）

  // 楽観的ロック：クライアントが読み込んだ時点の確定日時(expectedConfirmedAt)と、
  // 現在シート上の確定日時が一致しなければ、他の端末が先に確定・修正しているとみなして
  // 書き込まない（expectedConfirmedAtが無い場合はチェックをスキップする）
  if (!checkConfirmedPlanLock(values, foundRow, data.expectedConfirmedAt)) return;

  sheet.getRange(1, 1, 1, CONFIRMED_PLAN_HEADERS.length).setValues([CONFIRMED_PLAN_HEADERS]);

  // 修正前の公開状態をそのまま維持する。これより前に確定された行（列が無い・空）は
  // 従来どおり確定＝公開だったとみなし、この機会に明示的な「公開」へ正規化する
  var existingPublishState = String(values[foundRow - 1][17] || "") || "公開";
  var existingPublishedAt = values[foundRow - 1][18] || "";

  var ts = new Date();
  var row = [
    data.date,
    data.day,
    data.zuid,
    data.uva,
    data.chise || 0,
    data.ningiBreakdown || "",
    data.hqQty || 0,
    data.hqBreakdown || "",
    ts,
    data.zuidBreakdown || "",
    data.uvaBreakdown || "",
    data.chiseBreakdown || "",
    ts,
    data.rozen || 0,
    data.rozenBreakdown || "",
    data.ningiBreakdownByStore || "",
    data.chisePriorityAssignee || "自動",
    existingPublishState,
    existingPublishedAt
  ];
  sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
}

// 確定済みの日を、production.html（シフト表）に公開する。複数日を1回のリクエストで
// まとめて処理できる（「シフト表に公開」「確定した日をまとめて公開」の両方から呼ばれる）。
// data.items: [{date, expectedConfirmedAt}, ...]。日ごとに楽観的ロックを確認し、
// 一致しない日はその日だけ書き込みをスキップする（他の日の公開は続行する）。
function handlePublishDays(ss, data) {
  var sheet = ss.getSheetByName("確定プラン");
  if (!sheet) return; // 確定プランシート自体が無い＝公開対象の確定行も無い

  var values = sheet.getDataRange().getValues();
  var ts = new Date();
  var items = data.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var foundRow = findConfirmedPlanRow(values, item.date);
    if (foundRow === -1) continue; // 確定されていない日は対象外（無視）
    if (!checkConfirmedPlanLock(values, foundRow, item.expectedConfirmedAt)) continue; // 競合：この日だけスキップ
    sheet.getRange(foundRow, 18, 1, 2).setValues([["公開", ts]]);
  }
}

// 公開済みの日を、非公開（確定のみ）に戻す（「公開を取り消す」）。
function handleUnpublishDay(ss, data) {
  var sheet = ss.getSheetByName("確定プラン");
  if (!sheet) return;

  var values = sheet.getDataRange().getValues();
  var foundRow = findConfirmedPlanRow(values, data.date);
  if (foundRow === -1) return;
  if (!checkConfirmedPlanLock(values, foundRow, data.expectedConfirmedAt)) return;

  sheet.getRange(foundRow, 18, 1, 2).setValues([["非公開", ""]]);
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
    // 1行の解析で例外が起きても、その行だけスキップして残りの行は正常に返す
    // （1件の不正データのせいで確定プラン履歴が丸ごと「データなし」に見えるのを防ぐ）
    try {
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
      var rozen = Number(r[13]) || 0; // Rozen確定数（14列目）。この列が無い過去の行は0になる
      plans.push({
        date: iso,
        weekday: String(r[1] || ""),
        zuid: zuid,
        uva: uva,
        chise: chise,
        rozen: rozen,
        hqQty: hqQty,
        // 総生産数＝Zuid＋UvA＋チセ＋Rozen（本部製造数はこの内訳の一部であり、別途加算しない）
        total: zuid + uva + chise + rozen,
        // 具材別の内訳（"具材名×個数"をスペース区切り、メンバー内訳はさらに"名前:..."を「；」区切り）。
        // Zuid内訳・UvA内訳・チセ内訳・Rozen内訳は後から追加した列のため、それより前に確定された
        // 行では空文字になる（analytics.html側で「店舗別内訳データなし」として扱う）
        ningiBreakdown: String(r[5] || ""),
        hqBreakdown: String(r[7] || ""),
        zuidBreakdown: String(r[9] || ""),
        uvaBreakdown: String(r[10] || ""),
        chiseBreakdown: String(r[11] || ""),
        rozenBreakdown: String(r[14] || ""),
        // ニギニギ隊内訳（店舗別）（16列目）は後から追加した列のため、それより前に確定された
        // 行では空文字になる（どの店舗の分かを誰が担当したかが分からない＝店舗別内訳データなしとして扱う）
        ningiBreakdownByStore: String(r[15] || ""),
        // チセ優先担当（17列目）は後から追加した列のため、それより前に確定された行では
        // 空文字になる（＝自動として扱う）
        chisePriorityAssignee: String(r[16] || "") || "自動",
        // 公開状態（18列目）は後から追加した列のため、それより前に確定された行では空文字に
        // なる＝従来どおり確定と同時に公開だったとみなし「公開」として扱う
        publishState: String(r[17] || "") || "公開",
        publishedAtLabel: String(r[18] || ""),
      });
    } catch (rowErr) {
      // この行はスキップして次の行へ
      continue;
    }
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

// Dateオブジェクトを、gvizが日付型セルの値(cell.v)として返す "Date(y,m,d,h,mi,s)" 形式の
// 文字列に変換する（月は0始まり）。クライアント側はgviz経由で読んだ際の値をそのまま
// expectedUpdatedAtとして送り返すため、サーバー側もこの形式に合わせて比較する
// （スクリプトとスプレッドシートのタイムゾーンが一致している前提）。
function dateToGvizLiteral(d) {
  return "Date(" + d.getFullYear() + "," + d.getMonth() + "," + d.getDate() + "," +
    d.getHours() + "," + d.getMinutes() + "," + d.getSeconds() + ")";
}

function handleSaveDraft(ss, data) {
  var sheet = ss.getSheetByName("作業中プラン");
  if (!sheet) {
    sheet = ss.insertSheet("作業中プラン");
    sheet.appendRow(["日付", "forecast", "prod", "更新日時", "prodStore", "チセ優先担当", "手調整"]);
  } else if (sheet.getLastColumn() < 5) {
    // prodStore（ニギニギ隊内訳の店舗別の下書き）は後から追加した列。既存データの列位置は変えない
    sheet.getRange(1, 5).setValue("prodStore");
  } else if (sheet.getLastColumn() < 6) {
    // チセ優先担当（その日のチセ分を最優先で担当するメンバー）も後から追加した列。
    // 既存データの列位置は変えない
    sheet.getRange(1, 6).setValue("チセ優先担当");
  } else if (sheet.getLastColumn() < 7) {
    // 手調整（店舗ごとの合計を手で調整した分。{zuid,uva,rozen}のJSON）も後から追加した列
    sheet.getRange(1, 7).setValue("手調整");
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

  // 楽観的ロック：クライアントが読み込んだ時点の更新日時(expectedUpdatedAt)を送ってきた場合、
  // 現在シート上の更新日時と一致しなければ、他の端末が後から保存したとみなして書き込まない
  // （2つのタブ/端末で同じ日を開いていた場合に、後からの保存が先の保存を黙って上書きするのを防ぐ）。
  // expectedUpdatedAtが無い（従来互換・新規行）場合はチェックをスキップする。
  if (foundRow > 0 && data.expectedUpdatedAt) {
    var currentUpdatedAtCell = values[foundRow - 1][3];
    var currentUpdatedAtLiteral = currentUpdatedAtCell instanceof Date
      ? dateToGvizLiteral(currentUpdatedAtCell) : String(currentUpdatedAtCell || "");
    if (currentUpdatedAtLiteral && currentUpdatedAtLiteral !== String(data.expectedUpdatedAt)) {
      return; // 競合：書き込まずに中断する
    }
  }

  var row = [
    data.date,
    JSON.stringify(data.forecast || {}),
    JSON.stringify(data.prod || {}),
    new Date(),
    JSON.stringify(data.prodStore || {}),
    data.chisePriorityAssignee || "自動",
    JSON.stringify(data.manualAdjust || {})
  ];
  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, 7).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

// dateStr（yyyy-MM-dd）が[startIso, endIso]の範囲内かを判定する。
// startIso/endIsoの両方が未指定なら常にtrue（全件対象）を返す。
// yyyy-MM-dd形式同士は文字列比較がそのまま日付順の比較になる。
function isWithinDateWindow(dateStr, startIso, endIso) {
  if (!startIso && !endIso) return true;
  if (startIso && dateStr < startIso) return false;
  if (endIso && dateStr > endIso) return false;
  return true;
}

// startIso/endIso（yyyy-MM-dd）を指定すると、その範囲内の日付の行だけを返す。
// 指定しない場合は全件返す（handleGetDraft単体呼び出し時の後方互換用）。
function getDraftsData(ss, startIso, endIso) {
  var sheet = ss.getSheetByName("作業中プラン");
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var drafts = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var dateStr = normalizeDateCell(rows[i][0]);
    if (!isWithinDateWindow(dateStr, startIso, endIso)) continue;
    try {
      drafts.push({
        date: dateStr,
        forecast: JSON.parse(rows[i][1] || "{}"),
        prod: JSON.parse(rows[i][2] || "{}"),
        // prodStore（ニギニギ隊内訳の店舗別）は後から追加した列のため、無い行は{}になる
        prodStore: JSON.parse(rows[i][4] || "{}"),
        // 手調整（店舗ごとの合計を手で調整した分）も後から追加した列のため、無い行は{}になる
        manualAdjust: JSON.parse(rows[i][6] || "{}"),
      });
    } catch (err) {}
  }
  return drafts;
}

function handleGetDraft(ss) {
  return ContentService.createTextOutput(JSON.stringify({ drafts: getDraftsData(ss) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 指定した日（yyyy-MM-dd）の「作業中プラン」の現在の更新日時を返す（楽観的ロック用）。
// gviz経由の読み取り（admin.html側の他の確認用fetch）はGoogleスプレッドシート側のキャッシュにより
// 書き込み直後だと数秒程度古い値が返ることがあり、保存した直後に自分自身の書き込みを読み直す
// 用途には使えない（これが原因で、自分の保存を「他の端末の更新」と誤判定するバグがあった）。
// SpreadsheetAppで直接読むことで、書き込み直後でも常に最新の値を返す。
// 返す形式はhandleSaveDraftの競合判定(dateToGvizLiteral)と揃える。
function handleGetDraftUpdatedAt(ss, isoDate) {
  var sheet = ss.getSheetByName("作業中プラン");
  var updatedAt = null;
  if (sheet) {
    var values = sheet.getDataRange().getValues();
    var normalizedTarget = String(isoDate);
    for (var r = 1; r < values.length; r++) {
      if (normalizeDateCell(values[r][0]) === normalizedTarget) {
        var cell = values[r][3];
        updatedAt = cell instanceof Date ? dateToGvizLiteral(cell) : (cell ? String(cell) : null);
        break;
      }
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ updatedAt: updatedAt }))
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

// 今月のおにぎりの月次担当（1ヶ月ごとに1人へ全数割り振る対象者）を「年月（YYYY-MM）｜担当者」で
// 1ヶ月1行（月キーでupsert）保存する。初回作成時は初期データ（2026-10:CHIKAKO, 2026-11:YUMI）を
// シードする。assigneeが空文字の場合はその月の行を削除する（＝未設定の月として従来の割り振りに戻す）。
//
// 年月（1列目）は、"2026-11"のような文字列をGoogleスプレッドシートが日付として自動変換して
// しまい、後でgvizやgetValues()で読むと別の形（Date型や"Date(2026,10,1)"形式）で返ってきて
// 年月として読めなくなる不具合があった。setNumberFormat("@")で明示的に書式なしテキストに
// してから書き込むことで、この自動変換を防ぐ（writeMonthlyOnigiriRow参照）。
// 読み取りはgvizではなくApps Script側のtype=monthlyOnigiriエンドポイント（handleGetMonthlyOnigiri）
// で行う。gvizは列ごとにセルの型を多数決で決め、少数派の型の値をnullにする仕様があり、
// チセさんシートと同様の理由で値が消える恐れがあるため。
function monthlyOnigiriSheetHeader() { return ["年月（YYYY-MM）", "担当者"]; }

// 年月セルを明示的に書式なしテキストにしてから書き込む（日付への自動変換を防ぐ）
function writeMonthlyOnigiriRow(sheet, rowIndex, month, assignee) {
  sheet.getRange(rowIndex, 1).setNumberFormat("@").setValue(month);
  sheet.getRange(rowIndex, 2).setValue(assignee);
}

// 「今月のおにぎり担当」シートの年月セルの値を"yyyy-MM"文字列に正規化する。
// 過去にシートが日付として自動変換してしまった行（Date型で返る）・正しい文字列の
// どちらでも読み、どちらでもない場合はnullを返す（呼び出し側で「読み込めない行」として扱う）。
function normalizeMonthlyOnigiriMonth(rawValue) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    var y = rawValue.getFullYear();
    var m = rawValue.getMonth() + 1; // 0始まりのため+1
    return { month: y + "-" + ("0" + m).slice(-2), wasDate: true };
  }
  var s = String(rawValue || "").trim();
  if (/^\d{4}-\d{2}$/.test(s)) return { month: s, wasDate: false };
  return null;
}

function handleSaveMonthlyOnigiriAssignment(ss, data) {
  var header = monthlyOnigiriSheetHeader();
  var sheet = ss.getSheetByName("今月のおにぎり担当");
  if (!sheet) {
    sheet = ss.insertSheet("今月のおにぎり担当");
    sheet.appendRow(header);
    writeMonthlyOnigiriRow(sheet, 2, "2026-10", "CHIKAKO");
    writeMonthlyOnigiriRow(sheet, 3, "2026-11", "YUMI");
  } else {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }

  var month = String(data.month || "").trim();
  if (!month) return;
  var assignee = String(data.assignee || "").trim();

  // 年月セルが過去に日付として自動変換された行は文字列の単純比較では一致しないため、
  // normalizeMonthlyOnigiriMonthで正規化してから比較する（読めない行は対象外）。
  // 以前のバグで同じ月の行が複数できてしまっている場合は、保存時にまとめて1行へ片付ける。
  var values = sheet.getDataRange().getValues();
  var foundRows = [];
  for (var r = 1; r < values.length; r++) {
    var normalized = normalizeMonthlyOnigiriMonth(values[r][0]);
    if (normalized && normalized.month === month) foundRows.push(r + 1);
  }

  if (!assignee) {
    for (var i = foundRows.length - 1; i >= 0; i--) sheet.deleteRow(foundRows[i]);
    return;
  }

  if (foundRows.length > 0) {
    writeMonthlyOnigiriRow(sheet, foundRows[0], month, assignee);
    for (var j = foundRows.length - 1; j >= 1; j--) sheet.deleteRow(foundRows[j]);
  } else {
    var newRow = sheet.getLastRow() + 1;
    writeMonthlyOnigiriRow(sheet, newRow, month, assignee);
  }
}

// 「今月のおにぎり担当」シートを取得する。年月セルが過去に日付として自動変換されてしまった
// 行も正しく読み、かつその場で文字列として書き直す（以後の読み込みで自動変換の影響を
// 受けなくなる＝実質的な一度きりの移行処理を兼ねる）。年月として読めない行は黙って捨てず
// invalidRowsに積んで返し、admin.html側で警告表示に使う。
function getMonthlyOnigiriDataRaw_(ss) {
  var sheet = ss.getSheetByName("今月のおにぎり担当");
  if (!sheet) return { assignments: {}, invalidRows: [] };
  var values = sheet.getDataRange().getValues();
  var assignments = {};
  var invalidRows = [];
  for (var r = 1; r < values.length; r++) {
    var rawMonth = values[r][0];
    var assignee = String(values[r][1] || "").trim();
    if (!assignee) continue; // 担当者が空の行は未設定として扱う（対象外）

    var normalized = normalizeMonthlyOnigiriMonth(rawMonth);
    if (!normalized) {
      invalidRows.push({ row: r + 1, rawValue: String(rawMonth) });
      continue;
    }
    if (normalized.wasDate) {
      // 日付に自動変換されていた行をここで文字列に直す
      writeMonthlyOnigiriRow(sheet, r + 1, normalized.month, assignee);
    }
    // 同じ月の行が複数ある場合（過去のバグによる重複）は、シート上で後にある行を優先する
    assignments[normalized.month] = assignee;
  }
  return { assignments: assignments, invalidRows: invalidRows };
}

function handleGetMonthlyOnigiri(ss, noCache) {
  var text = withCache_("monthlyOnigiri_v1", noCache, function() {
    return JSON.stringify(getMonthlyOnigiriDataRaw_(ss));
  });
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// admin.htmlの初期表示が遅い問題（type=X形式のApps Script Web App呼び出しは、スクリプト本体の
// 処理が速くても、呼び出し自体に毎回1〜2秒程度かかる＝実測で確認済み）への対策の1つ。
// チセさんシート（直近の日付列だけに絞る）・店舗設定・今月のおにぎり担当の3つの小さい
// シートの読み込みを1回のApps Script呼び出しにまとめ、その「呼び出し自体の固定コスト」を
// 3回分から1回分に減らす。
// CacheService（5分）で結果をキャッシュし、続けて開いたときは速く返す。noCache=trueの
// 場合はキャッシュを使わず読み直す（admin.htmlの「データを更新」ボタン用）。
function handleGetSmallSheets(ss, noCache) {
  var text = withCache_("smallSheets_v1", noCache, function() {
    // チセさんシートは今日を基準に前後の日付列だけに絞って読む（1シーズンで200列を超える
    // ことがあり、admin.htmlの初期表示では直近数週間分しか使わないため）。
    // 過去30日・先40日分あれば、admin.htmlが表示する今週・来週・再来週（最大約21日先）に
    // 十分足りる余裕を持たせている。
    var chiseRows = getChiseSheetRowsWindowed_(30, 40);
    var storeSettingsRows = getStoreSettingsRowsRaw_(ss);
    var monthlyOnigiri = getMonthlyOnigiriDataRaw_(ss);
    return JSON.stringify({
      chiseSheet: { rows: chiseRows || [] },
      storeSettings: { rows: storeSettingsRows },
      monthlyOnigiri: monthlyOnigiri,
    });
  });
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// 店舗（Zuid・UvA・Rozengracht等）ごとの営業期間・営業曜日・予測の方法（天気で自動計算／
// 固定数）・曜日ごとの基準値/固定数を「店舗名」で1店舗1行（店舗名キーでupsert）保存する。
// 設定行が無い店舗は、クライアント側で「期間制限なし・曜日すべて営業」として扱う＝既存店舗
// （Zuid・UvA）は設定するまでこれまでの動きと完全に同じになる（この関数は保存のみ行い、
// 未設定時の既定値の解釈はクライアント側の責務）。
//
// 読み取りはgvizを使わず、type=storeSettingsエンドポイント（handleGetStoreSettings、
// getDisplayValues()経由）で行う。以前はgviz経由で読んでいたため、過去に列を追加した際に
// セルの型推定・列位置のずれにより、古い行の「更新日時」の値が新しい「月曜基準値」列として
// 読まれてNaNになったり、他の曜日が全部休業扱いになる不具合が起きた
// （チセさん/今月のおにぎり担当シートと同種の問題）。
// 保存側も同じ理由で、日付・曜日・数値をすべて明示的に書式なしテキスト（setNumberFormat("@")）
// としてから文字列で書き込み、Googleスプレッドシートによる自動型変換を防ぐ。
//
// 「平日基本数」「土日基本数」列（Rozengracht専用の固定数だった）は廃止し、「予測の方法」列
// （「天気で自動計算」「固定数」）と、全店舗共通の「月曜基準値」〜「日曜基準値」列（天気で
// 自動計算の店舗は気温・天気の調整前の基準値、固定数の店舗は曜日ごとの販売数そのもの）に
// 統合した。
var STORE_SETTINGS_SHEET_NAME = "店舗設定";
var STORE_SETTINGS_HEADER = ["店舗名", "開始日", "終了日", "月", "火", "水", "木", "金", "土", "日", "予測の方法",
  "月曜基準値", "火曜基準値", "水曜基準値", "木曜基準値", "金曜基準値", "土曜基準値", "日曜基準値",
  "売れ行き係数", "売れ行き開始日",
  "気温調整0℃以下%", "気温調整0-5℃%", "気温調整5-10℃%", "気温調整10-15℃%",
  "気温調整16-17℃%", "気温調整18-24℃%", "気温調整25-28℃%", "気温調整29℃以上%",
  "雨調整%", "保証最低数",
  "閉店時刻(平日)", "閉店時刻(土日)", "炊飯時間(分)", "下準備時間(分)", "判断締切時刻", "1合あたりの個数",
  "見込み係数(平日)12時", "見込み係数(平日)13時", "見込み係数(平日)14時", "見込み係数(平日)15時", "見込み係数(平日)16時", "見込み係数(平日)17時",
  "見込み係数(土日)12時", "見込み係数(土日)13時", "見込み係数(土日)14時", "見込み係数(土日)15時", "見込み係数(土日)16時", "見込み係数(土日)17時",
  "時間帯開始時刻", "時間帯終了時刻",
  "更新日時"];
// 「売れ行き係数」〜「保証最低数」（19〜29列目）は、「売れ行き＋天気」予測方式
// （store-settings.jsのresolveStoreForecast/calcSalesTrendForecast参照）のために追加した列。
// 既存の列（1〜18列目・更新日時）の位置・意味は変えていない。これより前に保存された行は
// これらの列が空になり、store-settings.jsのgetStoreTrendSettings()がDEFAULT_STORE_SETTINGSの
// 既定値にフォールバックする。
// 気温調整列は、冬の気温帯（15℃以下）をより細かく見るため「0℃以下」「0-5℃」「5-10℃」
// 「10-15℃」の4列に分けている（旧「気温調整15℃以下%」1列から変更。この機能はまだ
// 保存されたことが無いため、既存データへの影響は無い）。
// 「閉店時刻(平日)」〜「見込み係数(土日)17時」（31〜42列目）は、Rozengrachtの「見込み」
// （炊飯の目安）機能（store-settings.jsのcomputeRozenClosingEstimate参照）のために追加した列。
// 見込み係数は、実績データが少ない間は入力せず空欄（0扱い）のままにしておく運用を想定している
// （自動では計算しない。管理画面に表示される「データ蓄積」の通知を見て、admin.htmlの
// 　店舗設定画面で管理者が手入力する）。
// 「時間帯開始時刻」「時間帯終了時刻」（43〜44列目）は、店舗ごとに時間帯別実績で記録できる
// 時間の範囲（例：開始12時・終了19時）を設定するための列（store-settings.jsの
// resolveHourlySlots参照）。空欄の場合は既定値（12時〜19時、全店舗共通）にフォールバックする。

// 見出し名 -> 列index（0始まり）のマップを作る（hourlyHeaderIndex_と同じ考え方）。
function storeSettingsHeaderIndex_(header) {
  var idx = {};
  for (var i = 0; i < header.length; i++) {
    var name = String(header[i]).trim();
    if (name && idx[name] === undefined) idx[name] = i;
  }
  return idx;
}

function storeSettingsHeadersEqual_(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (String(a[i]).trim() !== String(b[i]).trim()) return false;
  }
  return true;
}

// 「店舗設定」シートの見出しを現在のSTORE_SETTINGS_HEADERに合わせ、既存の行を
// 「見出し名が一致する値だけ」新しい並びに移す（移行する）。見出し名が現在の
// STORE_SETTINGS_HEADERに無い古い列の値（例：旧「気温調整15℃以下%」1列だった頃の値）は
// 捨てる。見出しが既に現在のSTORE_SETTINGS_HEADERと完全に一致している場合は何もしない
// （余計な書き込みをしない。setValuesは見出しが違うときだけ実行する）。
//
// 【直していた不具合】設定項目（列）を追加・変更したとき、保存し直されなかった店舗の行は
// 古い列幅のままシートに残る。このとき見出し（1行目）だけを新しい列数で上書きすると、
// 古い行の「更新日時」の値（例："2026-11-21 17:19:45"）が、新しい見出しでは別の設定項目
// （例：新しく列が増えた分だけ右にずれた「気温調整29℃以上%」）の位置に来てしまい、
// その項目の値として誤って読まれてしまう（「月曜基準値」のときと同じ不具合のパターン）。
// 列の位置ではなく見出し名で値を移すことで、これを機械的に防ぐ。
//
// handleGetStoreSettings（読み込み時）・handleSaveStoreSettings（保存時）の両方から呼ぶ。
// 読み込み時にも呼ぶことで、誰も保存し直さなくても次にシートを開いた時点で自動的に直る。
function migrateStoreSettingsHeader_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    sheet.getRange(1, 1, 1, STORE_SETTINGS_HEADER.length).setNumberFormat("@").setValues([STORE_SETTINGS_HEADER]);
    return;
  }
  var lastCol = Math.max(sheet.getLastColumn(), STORE_SETTINGS_HEADER.length);
  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var oldHeader = values[0];
  if (storeSettingsHeadersEqual_(oldHeader, STORE_SETTINGS_HEADER)) return;

  var oldIdx = storeSettingsHeaderIndex_(oldHeader);
  var migratedRows = [];
  for (var r = 1; r < values.length; r++) {
    var oldRow = values[r];
    var newRow = [];
    for (var c = 0; c < STORE_SETTINGS_HEADER.length; c++) {
      var oldC = oldIdx[STORE_SETTINGS_HEADER[c]];
      newRow.push((oldC !== undefined && oldRow[oldC] !== undefined) ? oldRow[oldC] : "");
    }
    migratedRows.push(newRow);
  }

  sheet.getRange(1, 1, 1, STORE_SETTINGS_HEADER.length).setNumberFormat("@").setValues([STORE_SETTINGS_HEADER]);
  if (migratedRows.length > 0) {
    sheet.getRange(2, 1, migratedRows.length, STORE_SETTINGS_HEADER.length).setNumberFormat("@").setValues(migratedRows);
  }
  // 列を減らした場合などに、新しい見出しより右側に古い列の値が残らないよう消す
  if (lastCol > STORE_SETTINGS_HEADER.length) {
    sheet.getRange(1, STORE_SETTINGS_HEADER.length + 1, lastRow, lastCol - STORE_SETTINGS_HEADER.length).clearContent();
  }
}

function storeSettingsRowValues(store, data) {
  var weekdays = data.weekdays || {};
  var flagStr = function(key) { return weekdays[key] === false ? "FALSE" : "TRUE"; };
  var weekdayBase = data.weekdayBase || {};
  var numStr = function(v) {
    return (v !== undefined && v !== null && v !== "" && isFinite(Number(v))) ? String(Number(v)) : "";
  };
  var baseStr = function(key) { return numStr(weekdayBase[key]); };
  var methodStr = data.forecastMethod === "trend" ? "売れ行き＋天気"
    : data.forecastMethod === "weather" ? "天気で自動計算"
    : data.forecastMethod === "fixed" ? "固定数" : "";
  var tempAdjPct = data.tempAdjPct || {};
  var tempStr = function(key) { return numStr(tempAdjPct[key]); };
  var riceCoefWeekday = data.riceCoefWeekday || {};
  var riceCoefWeekend = data.riceCoefWeekend || {};
  var coefStr = function(map, hour) { return numStr(map[hour]); };
  var updatedAtStr = Utilities.formatDate(new Date(), "Etc/UTC", "yyyy-MM-dd HH:mm:ss");

  return [
    store,
    String(data.startDate || ""),
    String(data.endDate || ""),
    flagStr("mon"), flagStr("tue"), flagStr("wed"), flagStr("thu"), flagStr("fri"), flagStr("sat"), flagStr("sun"),
    methodStr,
    baseStr("mon"), baseStr("tue"), baseStr("wed"), baseStr("thu"), baseStr("fri"), baseStr("sat"), baseStr("sun"),
    numStr(data.salesTrendCoefficient),
    String(data.salesTrendStartDate || ""),
    tempStr("le0"), tempStr("b0_5"), tempStr("b5_10"), tempStr("b10_15"),
    tempStr("b16_17"), tempStr("b18_24"), tempStr("b25_28"), tempStr("ge29"),
    numStr(data.rainAdjPct),
    numStr(data.minGuarantee),
    String(data.closingTimeWeekday || ""),
    String(data.closingTimeWeekend || ""),
    numStr(data.riceCookMinutes),
    numStr(data.prepMinutes),
    String(data.decisionDeadline || ""),
    numStr(data.piecesPerGo),
    coefStr(riceCoefWeekday, 12), coefStr(riceCoefWeekday, 13), coefStr(riceCoefWeekday, 14),
    coefStr(riceCoefWeekday, 15), coefStr(riceCoefWeekday, 16), coefStr(riceCoefWeekday, 17),
    coefStr(riceCoefWeekend, 12), coefStr(riceCoefWeekend, 13), coefStr(riceCoefWeekend, 14),
    coefStr(riceCoefWeekend, 15), coefStr(riceCoefWeekend, 16), coefStr(riceCoefWeekend, 17),
    numStr(data.hourlyStartHour),
    numStr(data.hourlyEndHour),
    updatedAtStr
  ];
}

function handleSaveStoreSettings(ss, data) {
  var sheet = ss.getSheetByName(STORE_SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(STORE_SETTINGS_SHEET_NAME);
  }
  // 見出しを現在のSTORE_SETTINGS_HEADERに合わせ、他の店舗の行も含めて移行する
  // （保存操作をするのはこの店舗だけでも、見出し・他の行のずれはここで一緒に直す）
  migrateStoreSettingsHeader_(sheet);

  var store = String(data.store || "").trim();
  if (!store) return;
  var row = storeSettingsRowValues(store, data);

  var values = sheet.getDataRange().getValues();
  var foundRow = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim() === store) {
      foundRow = r + 1;
      break;
    }
  }
  var targetRow = foundRow > 0 ? foundRow : sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1, 1, row.length).setNumberFormat("@").setValues([row]);
}

// 「店舗設定」シートを、gvizの型推定を経由せずに返す（チセさんシートと同じ方式）。
// getDisplayValues()はセルの型推定を一切行わず、シート上の表示文字列をそのまま返すため、
// 過去に列を追加・変更した際の型推定・列位置のずれによる値消失・読み違いを避けられる。
// store-settings.js（admin.html・index.html・uva.html・rozen.html・cooking.html・
// production.htmlで共通利用）のparseStoreSettingsRows()が、ここで返した文字列の
// 2次元配列（1行目はヘッダー）を解析する。
function getStoreSettingsRowsRaw_(ss) {
  var sheet = ss.getSheetByName(STORE_SETTINGS_SHEET_NAME);
  if (!sheet) return [];
  // 読み込み時にも見出し・既存行のずれを直す（誰も保存し直さなくても自動的に直る）
  migrateStoreSettingsHeader_(sheet);
  return sheet.getDataRange().getDisplayValues();
}

function handleGetStoreSettings(ss, noCache) {
  var text = withCache_("storeSettings_v1", noCache, function() {
    return JSON.stringify({ rows: getStoreSettingsRowsRaw_(ss) });
  });
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// UvA学事暦（週開始日｜ISO週番号｜区分｜メモ）の初期データ。
// UvA公式の2026-2027年度アカデミックカレンダー（授業週・試験前週・試験週・休み）に基づく。
// 7月分の再試験は未確定のため、意図的にこの一覧には含めない（空けておく）。
// 年に1回、松木さんが直接スプレッドシート上で手で更新する前提のため、admin.htmlからの
// 書き込みハンドラは用意しない（閲覧・予測計算への反映のみgviz経由で行う）。
var UVA_ACADEMIC_CALENDAR_SEED_ROWS = [
  ["2026-08-31", "2026-W36", "授業", ""],
  ["2026-09-07", "2026-W37", "授業", ""],
  ["2026-09-14", "2026-W38", "授業", ""],
  ["2026-09-21", "2026-W39", "授業", ""],
  ["2026-09-28", "2026-W40", "授業", ""],
  ["2026-10-05", "2026-W41", "授業", ""],
  ["2026-10-12", "2026-W42", "試験前", ""],
  ["2026-10-19", "2026-W43", "試験", ""],
  ["2026-10-26", "2026-W44", "授業", ""],
  ["2026-11-02", "2026-W45", "授業", ""],
  ["2026-11-09", "2026-W46", "授業", ""],
  ["2026-11-16", "2026-W47", "授業", ""],
  ["2026-11-23", "2026-W48", "授業", ""],
  ["2026-11-30", "2026-W49", "授業", ""],
  ["2026-12-07", "2026-W50", "試験前", ""],
  ["2026-12-14", "2026-W51", "試験", ""],
  ["2026-12-21", "2026-W52", "休み", ""],
  ["2026-12-28", "2026-W53", "休み", ""],
  ["2027-01-04", "2027-W01", "授業", ""],
  ["2027-01-11", "2027-W02", "授業", ""],
  ["2027-01-18", "2027-W03", "試験前", ""],
  ["2027-01-25", "2027-W04", "試験", ""],
  ["2027-02-01", "2027-W05", "授業", ""],
  ["2027-02-08", "2027-W06", "授業", ""],
  ["2027-02-15", "2027-W07", "授業", ""],
  ["2027-02-22", "2027-W08", "授業", ""],
  ["2027-03-01", "2027-W09", "授業", ""],
  ["2027-03-08", "2027-W10", "授業", ""],
  ["2027-03-15", "2027-W11", "試験前", ""],
  ["2027-03-22", "2027-W12", "試験", ""],
  ["2027-03-29", "2027-W13", "授業", ""],
  ["2027-04-05", "2027-W14", "授業", ""],
  ["2027-04-12", "2027-W15", "授業", ""],
  ["2027-04-19", "2027-W16", "授業", ""],
  ["2027-04-26", "2027-W17", "授業", ""],
  ["2027-05-03", "2027-W18", "休み", ""],
  ["2027-05-10", "2027-W19", "授業", ""],
  ["2027-05-17", "2027-W20", "試験前", ""],
  ["2027-05-24", "2027-W21", "試験", ""],
  ["2027-05-31", "2027-W22", "授業", ""],
  ["2027-06-07", "2027-W23", "授業", ""],
  ["2027-06-14", "2027-W24", "試験前", ""],
  ["2027-06-21", "2027-W25", "試験", ""]
];

function ensureUvaAcademicCalendarSheet(ss) {
  var sheet = ss.getSheetByName("UvA学事暦");
  if (sheet) return;
  sheet = ss.insertSheet("UvA学事暦");
  sheet.appendRow(["週開始日（月曜）", "ISO週番号", "区分", "メモ"]);
  sheet.getRange(2, 1, UVA_ACADEMIC_CALENDAR_SEED_ROWS.length, 4).setValues(UVA_ACADEMIC_CALENDAR_SEED_ROWS);
}

// 区分ごとの係数設定。「授業」は基準(1.0固定)のためこのシートには含めない。
// 初期値はすべて1.0（未設定）とし、松木さんがadmin.htmlから値を決めて入力する。
var UVA_ACADEMIC_COEFFICIENT_CATEGORIES = ["試験前", "試験", "再試験", "休み"];

function ensureUvaAcademicCoefficientsSheet(ss) {
  var sheet = ss.getSheetByName("UvA学事暦設定");
  if (sheet) return;
  sheet = ss.insertSheet("UvA学事暦設定");
  sheet.appendRow(["区分", "係数"]);
  var rows = UVA_ACADEMIC_COEFFICIENT_CATEGORIES.map(function(cat) { return [cat, 1]; });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

// 区分ごとの係数を1件更新する（区分キーでupsert）。区分名はUVA_ACADEMIC_COEFFICIENT_CATEGORIES
// に含まれるもののみ受け付ける（授業は基準固定のため対象外）。
function handleSaveUvaAcademicCoefficient(ss, data) {
  var category = String(data.category || "").trim();
  if (UVA_ACADEMIC_COEFFICIENT_CATEGORIES.indexOf(category) === -1) return;
  var coefficient = Number(data.coefficient);
  if (!isFinite(coefficient) || coefficient < 0) return;

  var sheet = ss.getSheetByName("UvA学事暦設定");
  if (!sheet) { ensureUvaAcademicCoefficientsSheet(ss); sheet = ss.getSheetByName("UvA学事暦設定"); }

  var values = sheet.getDataRange().getValues();
  var foundRow = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim() === category) { foundRow = r + 1; break; }
  }
  var row = [category, coefficient];
  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
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
//
// 作業中プラン・具材ステータスは、admin.html/index.htmlが画面に表示する日付範囲
// （今日の少し前〜3週間ほど先まで）だけに絞って返す。この2シートには運用の中で
// 古い日付・大幅に未来の日付（テスト投入データ等）が積み重なっていくため、
// 表示に無関係な行までレスポンスに含めてしまうとペイロードが際限なく肥大化する。
function handleGetBootstrap(ss) {
  var today = new Date();
  var windowStart = new Date(today.getTime());
  windowStart.setDate(windowStart.getDate() - 3);
  var windowEnd = new Date(today.getTime());
  windowEnd.setDate(windowEnd.getDate() + 25);
  var startIso = Utilities.formatDate(windowStart, Session.getScriptTimeZone(), "yyyy-MM-dd");
  var endIso = Utilities.formatDate(windowEnd, Session.getScriptTimeZone(), "yyyy-MM-dd");

  return ContentService.createTextOutput(JSON.stringify({
    drafts: getDraftsData(ss, startIso, endIso),
    statuses: getStatusesData(ss, startIso, endIso),
    shiftConfig: getShiftConfigData(ss),
  })).setMimeType(ContentService.MimeType.JSON);
}

// 「メンバー」列は固定リストと照合しない自由文字列のため、ニギニギ隊の実名に加えて
// cooking.htmlが使う"本部"・"チセ(おにぎり)"・"チセ(具材のみ)"のような渡し先名も
// そのまま同じ列に保存できる（シート構造の変更不要。admin.html/index.htmlは実在する
// メンバー名しか参照しないため、これらの行が増えても既存表示には影響しない）。
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

  // 楽観的ロック：クライアントが読み込んだ時点の更新日時(expectedUpdatedAt)を送ってきた場合、
  // 現在シート上の更新日時と一致しなければ、他の端末が後から保存したとみなして書き込まない
  // （cooking.htmlのチェックリストが、他端末・admin.htmlでの更新を黙って上書きするのを防ぐ）。
  // expectedUpdatedAtが無い（従来互換のadmin.html/index.html等）場合はチェックをスキップする。
  if (foundRow > 0 && data.expectedUpdatedAt) {
    var currentUpdatedAtCell = values[foundRow - 1][5];
    var currentUpdatedAtLiteral = currentUpdatedAtCell instanceof Date
      ? dateToGvizLiteral(currentUpdatedAtCell) : String(currentUpdatedAtCell || "");
    if (currentUpdatedAtLiteral && currentUpdatedAtLiteral !== String(data.expectedUpdatedAt)) {
      return; // 競合：書き込まずに中断する
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

// 時間帯別実績シートが扱う全ての時間帯（店舗ごとに実際に使う範囲は「店舗設定」シートの
// 時間帯開始時刻・時間帯終了時刻で絞り込む。store-settings.jsのresolveHourlySlots参照）。
// 新しい時間帯を追加する場合は、この配列に追加し、HOURLY_SHEET_HEADERの末尾に
// 「〇時残り」「〇時売上」「〇時累計」「〇時あげた数」「〇時受取」の5列を追加すること
// （旧「〇時ランチ」「〇時スタンプ」は12〜18時専用の廃止済み列のため、新しい時間帯には作らない）。
var HOURLY_HOURS = [12, 13, 14, 15, 16, 17, 18, 19];

var HOURLY_SHEET_HEADER = ["日付", "曜日", "天気", "気温", "店舗", "場所名", "具材名", "作った数",
  "12時残り", "13時残り", "14時残り", "15時残り", "16時残り", "17時残り", "18時残り",
  "12時売上", "13時売上", "14時売上", "15時売上", "16時売上", "17時売上", "18時売上",
  "12時累計", "13時累計", "14時累計", "15時累計", "16時累計", "17時累計", "18時累計",
  "販売終了時間", "備考", "あげた数",
  "12時ランチ", "12時スタンプ", "13時ランチ", "13時スタンプ", "14時ランチ", "14時スタンプ",
  "15時ランチ", "15時スタンプ", "16時ランチ", "16時スタンプ", "17時ランチ", "17時スタンプ",
  "18時ランチ", "18時スタンプ",
  "12時あげた数", "13時あげた数", "14時あげた数", "15時あげた数", "16時あげた数", "17時あげた数", "18時あげた数",
  "12時受取", "13時受取", "14時受取", "15時受取", "16時受取", "17時受取", "18時受取",
  "Zuidへ移動", "Rozengrachtへ移動", "更新日時", "UvAへ移動",
  "19時残り", "19時売上", "19時累計", "19時あげた数", "19時受取"];
// 「更新日時」（列63、1始まり）は楽観的ロックの基準として列番号を固定で参照している
// （HOURLY_UPDATED_AT_COL）。この列より後に新しい列を追加しても「更新日時」の位置は
// 変わらないようにするため、新しい列は必ず「更新日時」より後ろに追加すること。
var HOURLY_UPDATED_AT_COL = 63;
// 「あげた数」列（単一）・「〇時ランチ」「〇時スタンプ」列は、時間帯ごとの
// 「〇時あげた数」列（ランチ・スタンプ統合）に置き換えられたため以後は書き込まない
// （既存行の後方互換のため列自体は残す。過去データの読み取り時はgetHourlySheetRowsで
// 　新列が空なら旧ランチ・スタンプ列の合計にフォールバックする）
// 「〇時受取」（他店舗からの合流分。現在はZuid・UvA・Rozengrachtが使用）・「Zuidへ移動」
// （UvA・Rozengracht。1日1回）・「Rozengrachtへ移動」（Zuid・UvA。1日1回）・「更新日時」・
// 「UvAへ移動」（Rozengrachtのみ・1日1回）・「19時残り」〜「19時受取」は末尾に追加した列。
// 過去の行はこれらの列を持たないため、読み込み時は空欄=0（更新日時は空文字）として扱う
// （getHourlySheetRowsのat()が""を返し、calcHourlySoldAndCumulative/analytics.html側で
// Number("")=0相当に扱われる）。
// 「Zuidへ移動」「Rozengrachtへ移動」は、どの店舗からの移動かに関わらず同じ列を使い回す
// （行＝店舗ごとに値を持つため、列の意味は「その行の店舗から見た移動先」で一意に決まる）。
// 「更新日時」は、uva.html/rozen.html（スタッフ用の店舗別入力ページ）とindex.htmlが
// 同じ日・同じ店舗を同時に編集した場合の楽観的ロックに使う（handleSaveHourly参照）。
//
// getHourlySheetRows・handleSaveHourlyは、時間帯の列（〇時残り等）を含む全ての列を
// HOURLY_SHEET_HEADERの見出し名で探して読み書きする（配列の位置を直接指定しない）。
// これにより、新しい時間帯を末尾に追加しても既存列の読み書きがずれない。
function hourlyHeaderIndex_() {
  var idx = {};
  for (var i = 0; i < HOURLY_SHEET_HEADER.length; i++) {
    if (idx[HOURLY_SHEET_HEADER[i]] === undefined) idx[HOURLY_SHEET_HEADER[i]] = i;
  }
  return idx;
}

// 各時間帯残数と、その時間帯の「あげた数」「受け取った数」から、時間帯ごとの売れた数・
// 累計売上を算出する。あげた数はその時間帯で実際に減った分から除外し、受け取った数
// （UvAからZuidへの合流分）は見かけ上残数が増える要因のため加算してから、
// 「純粋な販売数」を算出する。receivedsを省略した場合は常に0として扱われ、
// 受け取りの無いUvA側は従来通りの計算式になる。
// 売れた数[i] = (i==0 ? 作った数 : 直前の残数) + 受け取った数[i] - 残数[i] - あげた数[i]
//              （残数の前後どちらかが未入力なら空欄）
// 累計売上[i] = 作った数 + (0〜iの受け取った数の累計) - 残数[i] - (0〜iのあげた数の累計)（残数が未入力なら空欄）
function calcHourlySoldAndCumulative(made, remains, givens, receiveds) {
  var sold = [];
  var cumulative = [];
  var prev = made;
  var givenSum = 0;
  var receivedSum = 0;
  for (var i = 0; i < remains.length; i++) {
    var curr = remains[i];
    var hasCurr = curr !== "" && curr !== null && curr !== undefined;
    var hasPrev = prev !== "" && prev !== null && prev !== undefined;
    var given = Number(givens[i] || 0);
    var received = Number((receiveds && receiveds[i]) || 0);
    sold.push(hasCurr && hasPrev ? (Number(prev) + received - Number(curr) - given) : "");
    givenSum += given;
    receivedSum += received;
    var hasMade = made !== "" && made !== null && made !== undefined;
    cumulative.push(hasCurr && hasMade ? (Number(made) + receivedSum - Number(curr) - givenSum) : "");
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
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), HOURLY_SHEET_HEADER.length);
  var idx = hourlyHeaderIndex_();
  // 実績シートの行数が増えても保存処理が遅くならないよう、まず日付・店舗・具材名の
  // 3列（A・E・G列）だけを読み取って該当行を特定し、既存値の保持が必要な行だけを
  // 全列読み取る（getHourlySheetRowsの読み取り範囲限定と同じ方針）。
  var keyCols = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 7).getValues() : [];
  // 楽観的ロックの比較用に、「更新日時」列（HOURLY_UPDATED_AT_COLで固定）だけを別途まとめて読む
  // （keyColsと同じ開始行・件数で読むため、同じインデックスrで対応する行を指す。
  // 　「更新日時」より後ろに列を追加しても位置が変わらないよう、列番号は固定で参照する）。
  var updatedAtCol = lastRow >= 2 ? sheet.getRange(2, HOURLY_UPDATED_AT_COL, lastRow - 1, 1).getValues() : [];

  // 曜日・天気・気温は本来「その日」単位の情報で、本来はどの店舗の行も同じ値を持つ。
  // index.htmlは毎回これらを送ってくるが、uva.html/rozen.html（スタッフ用の店舗別入力
  // ページ）は天気情報を取得しないため送ってこない。その場合は、同じ日付の既存行
  // （店舗は問わない）から曜日・天気・気温を引き継ぐ（空のまま上書きしてしまうと、
  // 既にindex.html側で保存されていた天気情報が消えてしまうため）。
  var effectiveWeekday = data.weekday || "";
  var effectiveWeather = data.weather || "";
  var effectiveTemp = (data.temp !== undefined && data.temp !== null && data.temp !== "") ? data.temp : "";
  if (!effectiveWeekday || !effectiveWeather || effectiveTemp === "") {
    for (var fr = 0; fr < keyCols.length; fr++) {
      if (normalizeDateCell(keyCols[fr][0]) === String(data.date)) {
        if (!effectiveWeekday) effectiveWeekday = String(keyCols[fr][1] || "");
        if (!effectiveWeather) effectiveWeather = String(keyCols[fr][2] || "");
        if (effectiveTemp === "" && keyCols[fr][3] !== "" && keyCols[fr][3] !== null && keyCols[fr][3] !== undefined) {
          effectiveTemp = keyCols[fr][3];
        }
        break;
      }
    }
  }

  (data.stores || []).forEach(function(storeData) {
    // 楽観的ロック：クライアントが読み込んだ時点の更新日時(expectedUpdatedAt)を送ってきた
    // 場合、現在シート上の「この日・この店舗」の行のうち最新の更新日時と比較する。
    // 異なれば、他の端末（index.html・uva.html・rozen.htmlのいずれか）が後から保存した
    // とみなし、この店舗分は書き込まずにスキップする（クライアント側は保存直前に別途
    // fetchして比較し、ここに到達する前に止めるのが基本。これはその最終防衛線）。
    // expectedUpdatedAtが無い（従来互換・新規データ）場合はチェックをスキップする。
    if (storeData.expectedUpdatedAt) {
      var currentMax = 0;
      for (var kr = 0; kr < keyCols.length; kr++) {
        if (normalizeDateCell(keyCols[kr][0]) === String(data.date) &&
            String(keyCols[kr][4]) === String(storeData.store)) {
          var uAt = updatedAtCol[kr][0];
          var uMs = uAt instanceof Date ? uAt.getTime() : 0;
          if (uMs > currentMax) currentMax = uMs;
        }
      }
      if (currentMax > 0 && String(currentMax) !== String(storeData.expectedUpdatedAt)) {
        return; // 競合：この店舗分は書き込まずにスキップする
      }
    }

    (storeData.items || []).forEach(function(item) {
      var foundRow = -1;
      for (var r = 0; r < keyCols.length; r++) {
        if (normalizeDateCell(keyCols[r][0]) === String(data.date) &&
            String(keyCols[r][4]) === String(storeData.store) &&
            String(keyCols[r][6]) === String(item.filling)) {
          foundRow = r + 2;
          break;
        }
      }
      var existing = foundRow > 0 ? sheet.getRange(foundRow, 1, 1, lastCol).getValues()[0] : null;

      // 未入力（""や未指定）の場合は、保存済みの既存値をそのまま保持する（明示的な0は尊重する）。
      // Zuidへ移動・Rozengrachtへ移動・UvAへ移動（いずれも1日1回の値）で共通して使う。
      function resolveMovedValue_(submitted, existingIdxName) {
        if (submitted === "" || submitted === null || submitted === undefined) {
          var existingIdx = idx[existingIdxName];
          return (existing && existingIdx !== undefined) ? (Number(existing[existingIdx]) || 0) : 0;
        }
        return Number(submitted) || 0;
      }

      // 時間帯ごとの残数・あげた数・受け取った数をHOURLY_HOURS（12〜19時）の順で組み立てる。
      // 既存行がある場合、今回の送信で空欄（未入力）になっているスロットは、保存済みデータの
      // 復元がまだ完了していないタイミングで保存ボタンが押された可能性があるため、過去に
      // 保存済みの実績を空欄で上書きして消してしまわないよう、シート上の既存値を保持する
      // （あげた数・受け取った数も同様。見出し名で既存値の列を探すため、新しい時間帯を
      // 末尾に追加しても既存の12〜18時分の読み書きはずれない）。
      var remains = [], givens = [], receiveds = [];
      HOURLY_HOURS.forEach(function(h) {
        var rv = item["r" + h];
        var gv = Number(item["given" + h] || 0);
        var cv = Number(item["received" + h] || 0);
        if ((rv === "" || rv === null || rv === undefined) && existing) {
          var remainIdx = idx[h + "時残り"];
          var existingRemain = remainIdx !== undefined ? existing[remainIdx] : "";
          if (existingRemain !== "" && existingRemain !== null && existingRemain !== undefined) {
            rv = existingRemain;
            var givenIdx = idx[h + "時あげた数"];
            var lunchIdx = idx[h + "時ランチ"];
            var stampIdx = idx[h + "時スタンプ"];
            gv = givenOrLegacySum(
              givenIdx !== undefined ? existing[givenIdx] : "",
              lunchIdx !== undefined ? existing[lunchIdx] : "",
              stampIdx !== undefined ? existing[stampIdx] : ""
            ) || 0;
            var receivedIdx = idx[h + "時受取"];
            var existingReceived = receivedIdx !== undefined ? existing[receivedIdx] : "";
            cv = (existingReceived !== "" && existingReceived !== null && existingReceived !== undefined) ? Number(existingReceived) : 0;
          }
        }
        remains.push(rv === "" || rv === null || rv === undefined ? "" : rv);
        givens.push(gv);
        receiveds.push(cv);
      });

      var total = item.total;
      if ((total === "" || total === null || total === undefined || Number(total) === 0) &&
          existing && Number(existing[idx["作った数"]] || 0) > 0) {
        total = existing[idx["作った数"]];
      }

      var moved = resolveMovedValue_(item.movedToZuid, "Zuidへ移動");
      var movedRozen = resolveMovedValue_(item.movedToRozengracht, "Rozengrachtへ移動");
      var movedUva = resolveMovedValue_(item.movedToUva, "UvAへ移動");

      // 販売終了時間・備考：uva.html/rozen.html（スタッフ用の店舗別入力ページ）はこれらの
      // 入力欄を持たないため、キー自体を送ってこない（undefined）。その場合は空文字で
      // 上書きしてしまわず、既存の値をそのまま保持する。storeData.soldOutTime/noteが
      // 明示的に（空文字も含めて）送られてきた場合（index.html）は、その値をそのまま使う
      // （index.htmlでメモ等を意図的に空にして保存するケースと区別するため）。
      var soldOutTime = (storeData.soldOutTime !== undefined)
        ? (storeData.soldOutTime || "")
        : (existing ? String(existing[idx["販売終了時間"]] || "") : "");
      var note = (storeData.note !== undefined)
        ? (storeData.note || "")
        : (existing ? String(existing[idx["備考"]] || "") : "");

      var calc = calcHourlySoldAndCumulative(total, remains, givens, receiveds);

      var row = new Array(HOURLY_SHEET_HEADER.length).fill("");
      row[idx["日付"]] = data.date;
      row[idx["曜日"]] = effectiveWeekday;
      row[idx["天気"]] = effectiveWeather;
      row[idx["気温"]] = effectiveTemp;
      row[idx["店舗"]] = storeData.store;
      row[idx["場所名"]] = storeData.location;
      row[idx["具材名"]] = item.filling;
      row[idx["作った数"]] = total;
      HOURLY_HOURS.forEach(function(h, hi) {
        row[idx[h + "時残り"]] = remains[hi];
        row[idx[h + "時売上"]] = calc.sold[hi];
        row[idx[h + "時累計"]] = calc.cumulative[hi];
        row[idx[h + "時あげた数"]] = givens[hi];
        row[idx[h + "時受取"]] = receiveds[hi];
        // 旧「〇時ランチ」「〇時スタンプ」（12〜18時のみ存在）は、以後書き込まない
        // 廃止済み列のため、保存するたびに常に空にする（既存動作と同じ）
        if (idx[h + "時ランチ"] !== undefined) row[idx[h + "時ランチ"]] = "";
        if (idx[h + "時スタンプ"] !== undefined) row[idx[h + "時スタンプ"]] = "";
      });
      row[idx["販売終了時間"]] = soldOutTime;
      row[idx["備考"]] = note;
      row[idx["あげた数"]] = ""; // 単一・廃止、後方互換のため列のみ維持
      row[idx["Zuidへ移動"]] = moved;
      row[idx["Rozengrachtへ移動"]] = movedRozen;
      row[idx["更新日時"]] = new Date(); // この位置（列63固定）は変えない
      row[idx["UvAへ移動"]] = movedUva;

      if (foundRow > 0) {
        sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
      } else {
        sheet.appendRow(row);
      }
    });
  });
}

// startIso/endIso（yyyy-MM-dd）を指定すると、その範囲内の日付の行だけを返す。
// 指定しない場合は全件返す（handleGetStatus単体呼び出し時の後方互換用）。
function getStatusesData(ss, startIso, endIso) {
  var sheet = ss.getSheetByName("具材ステータス");
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var statuses = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var dateStr = normalizeDateCell(rows[i][0]);
    if (!isWithinDateWindow(dateStr, startIso, endIso)) continue;
    statuses.push({
      date: dateStr,
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
// sinceFilter（yyyy-MM-dd）を指定すると、その日付以降の行だけを読み込む（dateFilterより
// 優先度低：Zuidの「売れ行き＋天気」で直近の売れ行き(L)を計算するためだけに、全件より
// 軽い範囲で最近のデータを取得したいindex.html・admin.html向け）。
// どちらも指定しない場合（analytics.html向け）は従来通り全行を読み取る。
function getHourlySheetRows(ss, dateFilter, sinceFilter) {
  var sheet = ss.getSheetByName("時間帯別実績");
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), HOURLY_SHEET_HEADER.length);

  var dataRows;
  if (dateFilter || sinceFilter) {
    // A列（日付）だけをまず1回のbulk読み取りで取得し、該当する行番号の範囲（最小〜最大）を
    // 特定してから、その範囲だけをもう1回のbulk読み取りで取得する（計2回のSpreadsheet
    // サービス呼び出しで済ませる）。
    // 以前は該当行ごとに個別にgetRange().getValues()を呼んでいたため、sinceFilterで
    // 数百〜千行以上が該当する場合（Zuidの「売れ行き＋天気」で直近45日分を取得する用途）、
    // 呼び出し回数が行数分に膨れ上がり、実測30秒以上かかる不具合があった。
    var dateCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var predicate = dateFilter
      ? function(v) { return v && normalizeDateCell(v) === dateFilter; }
      : function(v) { return v && normalizeDateCell(v) >= sinceFilter; };
    var minIdx = -1, maxIdx = -1;
    for (var i = 0; i < dateCol.length; i++) {
      if (predicate(dateCol[i][0])) {
        if (minIdx === -1) minIdx = i;
        maxIdx = i;
      }
    }
    if (minIdx === -1) {
      dataRows = [];
    } else {
      // 該当行が離れていても、最小〜最大行番号の範囲をまとめて1回で読み取り、
      // その中から実際に条件に合う行だけをJavaScript側で絞り込む
      var spanRows = sheet.getRange(minIdx + 2, 1, maxIdx - minIdx + 1, lastCol).getValues();
      dataRows = spanRows.filter(function(r) { return predicate(r[0]); });
    }
  } else {
    dataRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  }

  var idx = hourlyHeaderIndex_();
  // 見出し名で列を探す。その見出しの列自体が無い（古いシート、または19時専用列の
  // ように後から追加した列が、まだヘッダーを拡張していないシートに無い）場合は""を返す
  function at(r, name) {
    var i = idx[name];
    if (i === undefined) return "";
    var val = r[i];
    return val !== "" && val !== null && val !== undefined ? val : "";
  }

  var result = [];
  for (var j = 0; j < dataRows.length; j++) {
    if (!dataRows[j][0]) continue;
    var r = dataRows[j];
    var row = {
      date:        normalizeDateCell(r[idx["日付"]]),
      weekday:     String(r[idx["曜日"]] || ""),
      weather:     String(r[idx["天気"]] || ""),
      temp:        at(r, "気温"),
      store:       String(r[idx["店舗"]] || ""),
      location:    String(r[idx["場所名"]] || ""),
      filling:     String(r[idx["具材名"]] || ""),
      total:       at(r, "作った数"),
      soldOutTime: normalizeTimeCell(r[idx["販売終了時間"]]),
      note:        String(r[idx["備考"]] || ""),
      given:       at(r, "あげた数"),
      // 「〇時受取」「Zuidへ移動」「Rozengrachtへ移動」「UvAへ移動」は後から追加した
      // 列のため、それより前に保存された行では空文字になる（0として扱われる）
      movedToZuid: at(r, "Zuidへ移動"),
      movedToRozengracht: at(r, "Rozengrachtへ移動"),
      movedToUva: at(r, "UvAへ移動"),
      // 楽観的ロック用。epochミリ秒の数値（文字列化して比較する）で返す。
      // タイムゾーンや表示形式の差異を気にせず単純比較できるようにするため。
      updatedAt: r[idx["更新日時"]] instanceof Date ? r[idx["更新日時"]].getTime() : "",
    };
    HOURLY_HOURS.forEach(function(h) {
      var legacyLunch = at(r, h + "時ランチ");
      var legacyStamp = at(r, h + "時スタンプ");
      row["r" + h] = at(r, h + "時残り");
      row["sold" + h] = at(r, h + "時売上");
      row["cum" + h] = at(r, h + "時累計");
      row["lunch" + h] = legacyLunch;
      row["stamp" + h] = legacyStamp;
      // 新形式の「〇時あげた数」が空の古い行は、旧形式の「〇時ランチ」＋「〇時スタンプ」の
      // 合計にフォールバックする（19時のように旧ランチ・スタンプ列を持たない時間帯は、
      // legacyLunch/legacyStampが常に""のため、givenOrLegacySumは単にnewValをそのまま返す）
      row["given" + h] = givenOrLegacySum(at(r, h + "時あげた数"), legacyLunch, legacyStamp);
      row["received" + h] = at(r, h + "時受取");
    });
    result.push(row);
  }
  return result;
}

function handleGetHourly(ss, dateFilter, sinceFilter) {
  return ContentService.createTextOutput(JSON.stringify({ rows: getHourlySheetRows(ss, dateFilter, sinceFilter) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// データ分析ページ（analytics.html）向け。時間帯別実績の全行を
// 日付・曜日・天気・気温を含む形で返す
function handleGetAnalytics(ss) {
  return ContentService.createTextOutput(JSON.stringify({ rows: getHourlySheetRows(ss) }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Zuidの気温調整%（店舗設定のTREND_TEMP_BINS、store-settings.js参照）の各気温帯について、
// 実績データが何日分たまっているかを数える。admin.htmlの店舗設定画面で、「0〜5℃」「0℃以下」の
// ように調整値が未確定な気温帯のデータが一定日数たまったことを知らせる表示に使う
// （自動で調整値を変えることは一切しない。カウントのみ）。
//
// 気温の基準は、天気で自動計算・売れ行き＋天気の計算で使っている「11〜15時平均気温」
// （admin.html/index.htmlのcomputeSalesWeatherと同じ定義：11・12・13・14時の気温の平均）。
// 時間帯別実績シートの「気温」列は保存時点の予報の最高気温（index.htmlのtemp:
// Math.round(today.maxTemp)）で、ビンの基準である11-15時平均とは別の値のため使わず、
// Open-Meteoの過去気象（archive-api.open-meteo.com）から該当日の11-15時平均を取得し直す。
var ZUID_LAT_ = 52.3676, ZUID_LON_ = 4.9041;

function tempBinKeyFor_(temp) {
  if (temp <= 0) return "le0";
  if (temp <= 5) return "b0_5";
  if (temp <= 10) return "b5_10";
  if (temp <= 15) return "b10_15";
  if (temp <= 17) return "b16_17";
  if (temp <= 24) return "b18_24";
  if (temp <= 28) return "b25_28";
  return "ge29";
}

function countZuidTempBinDays_(ss) {
  var counts = { le0: 0, b0_5: 0, b5_10: 0, b10_15: 0, b16_17: 0, b18_24: 0, b25_28: 0, ge29: 0 };

  // Zuidが実際に営業した日付（時間帯別実績シートに記録がある日）を重複無く集める
  var rows = getHourlySheetRows(ss, null, null);
  var seen = {};
  var zuidDates = [];
  rows.forEach(function(r) {
    if (r.store !== "Zuid" || !r.date || seen[r.date]) return;
    seen[r.date] = true;
    zuidDates.push(r.date);
  });
  if (zuidDates.length === 0) return { counts: counts, totalDays: 0 };
  zuidDates.sort();

  // 過去気象はまだ無い未来日・今日を除き、昨日までに制限する
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var yesterdayIso = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), "yyyy-MM-dd");
  var startDate = zuidDates[0];
  var endDate = zuidDates[zuidDates.length - 1];
  if (endDate > yesterdayIso) endDate = yesterdayIso;
  if (startDate > endDate) return { counts: counts, totalDays: 0 };

  var url = "https://archive-api.open-meteo.com/v1/archive?latitude=" + ZUID_LAT_ + "&longitude=" + ZUID_LON_ +
    "&start_date=" + startDate + "&end_date=" + endDate +
    "&hourly=temperature_2m&timezone=Europe%2FAmsterdam";
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { counts: counts, totalDays: 0, error: "archive-api.open-meteo.comの取得に失敗しました" };
  var data = JSON.parse(resp.getContentText());
  var hourlyTime = (data.hourly && data.hourly.time) || [];
  var hourlyTemp = (data.hourly && data.hourly.temperature_2m) || [];

  // 日付 -> [11,12,13,14時の気温]
  var tempsByDate = {};
  for (var i = 0; i < hourlyTime.length; i++) {
    var parts = hourlyTime[i].split("T");
    var d = parts[0];
    var hour = parseInt(parts[1].slice(0, 2), 10);
    if (hour < 11 || hour > 14) continue;
    if (hourlyTemp[i] === null || hourlyTemp[i] === undefined) continue;
    if (!tempsByDate[d]) tempsByDate[d] = [];
    tempsByDate[d].push(hourlyTemp[i]);
  }

  var totalDays = 0;
  zuidDates.forEach(function(dateIso) {
    if (dateIso > endDate) return;
    var temps = tempsByDate[dateIso];
    if (!temps || temps.length === 0) return;
    var avg = temps.reduce(function(s, t) { return s + t; }, 0) / temps.length;
    counts[tempBinKeyFor_(avg)]++;
    totalDays++;
  });
  return { counts: counts, totalDays: totalDays };
}

// 過去気象の取得を伴うため、他のキャッシュより長め（6時間＝CacheServiceの上限）にキャッシュする
function handleGetTempBinDayCounts(ss) {
  var text = withCache_("tempBinDayCounts_v1", false, function() {
    return JSON.stringify(countZuidTempBinDays_(ss));
  }, 21600);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// チセさんの生産データ（「オーダー表」シート）を、gvizの型推定を経由せずに返す。
// gvizはセルの値を列（日付）ごとに多数決で型推定し、少数派の型のセルをnullにする仕様があるため、
// その列に数値が1個しか無く、曜日表記の文字セルと数が同数か少ないと、本来入っている数値が
// nullとして返ってきてしまう不具合があった（例：ある土曜列に「具材のみ」の数値が1個だけ
// 入っていたケース）。getDisplayValues()は型推定を一切行わず、シート上の表示文字列を
// そのまま全セル取得できるため、この問題を避けられる。
// admin.html・cooking.html側ではchise-sheet.jsのparseChiseSheetRows()が、ここで返した
// 文字列の2次元配列を解析して具材別の個数（数値）に変換する。
// type=X形式のApps Script読み込みの結果をCacheService（スクリプト単位、5分）でキャッシュする
// 共通ヘルパー。実測で、type=X呼び出しはスクリプト本体の処理が速くてもWeb App呼び出し自体に
// 毎回1〜2秒程度かかることが分かったため、頻繁に変わらないデータ（チセさんシート・店舗設定・
// 今月のおにぎり担当等）はキャッシュして2回目以降を速くする。
// noCache=trueの場合はキャッシュを使わず読み直す（admin.htmlの「データを更新」ボタン用）。
// textFn: キャッシュが無い場合に呼ぶ、JSON文字列を返す関数
// ttlSeconds省略時は300秒（5分）。外部APIを呼ぶ等、変化が少なく重い処理はより長く指定できる
// （CacheServiceの上限は21600秒＝6時間）。
function withCache_(cacheKey, noCache, textFn, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  if (!noCache) {
    var cached = cache.get(cacheKey);
    if (cached) return cached;
  }
  var text = textFn();
  try {
    // CacheServiceは1キー最大100KBまで。超えた場合はキャッシュ保存だけ失敗させ、
    // 読み込み自体は失敗させない
    cache.put(cacheKey, text, ttlSeconds || 300);
  } catch (cacheErr) {}
  return text;
}

function handleGetChiseSheet(noCache) {
  var text = withCache_("chiseSheet_v1", noCache, function() {
    var rows = getChiseSheetRowsAll_();
    if (rows === null) return JSON.stringify({ error: "シート「オーダー表」が見つかりません", rows: [] });
    return JSON.stringify({ rows: rows });
  });
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// 「オーダー表」シートの全列を取得する（従来の挙動。cooking.html等、広い期間が必要な
// 呼び出し元向けに残す）。シートが無い場合はnullを返す。
function getChiseSheetRowsAll_() {
  var ss = SpreadsheetApp.openById(CHISE_SHEET_ID);
  var sheet = ss.getSheetByName("オーダー表");
  if (!sheet) return null;
  return sheet.getDataRange().getDisplayValues();
}

// 「オーダー表」シートのうち、今日を基準に前後daysBack/daysForward日分の日付列だけを
// 読む（具材名の列（0列目）は常に含める）。このシートは1シーズンで200列を超えることがあり、
// admin.htmlの初期表示では直近数週間分の日付しか使わないため、必要な列だけに絞って
// 読み取る（getHourlySheetRowsのsinceフィルタと同じ、呼び出し回数を増やさない方式：
// 列0だけのbulk読み取り1回＋絞り込んだ列範囲のbulk読み取り1回の計2回で済ませる）。
// シートが無い場合はnullを返す。
function getChiseSheetRowsWindowed_(daysBack, daysForward) {
  var ss = SpreadsheetApp.openById(CHISE_SHEET_ID);
  var sheet = ss.getSheetByName("オーダー表");
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];

  var headerRow = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var today = new Date();
  var todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var minDate = new Date(todayMidnight.getTime() - daysBack * 86400000);
  var maxDate = new Date(todayMidnight.getTime() + daysForward * 86400000);

  var minColIdx = -1, maxColIdx = -1; // 0始まり
  for (var c = 0; c < headerRow.length; c++) {
    var m = String(headerRow[c] || "").match(/^(\d{1,2})\/(\d{1,2})/);
    if (!m) continue;
    var mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
    // 年情報が無いため、今日に最も近い年を推測する（admin.html等、他の日付推測と同じ考え方）
    var candidate = new Date(todayMidnight.getFullYear(), mo - 1, da);
    var diffDays = (candidate - todayMidnight) / 86400000;
    if (diffDays < -180) candidate = new Date(todayMidnight.getFullYear() + 1, mo - 1, da);
    else if (diffDays > 180) candidate = new Date(todayMidnight.getFullYear() - 1, mo - 1, da);
    if (candidate >= minDate && candidate <= maxDate) {
      if (minColIdx === -1) minColIdx = c;
      maxColIdx = c;
    }
  }

  // 具材名の列（0列目）は全行、1回のbulk読み取りで取得する
  var labelCol = sheet.getRange(1, 1, lastRow, 1).getDisplayValues();
  if (minColIdx === -1) {
    // 窓の範囲に該当する日付列が無い場合は、具材名の列だけを返す（商品名の判定等は
    // できるが、日付別のデータは無い＝呼び出し側ではその日付のデータ無しとして扱われる）
    return labelCol;
  }
  // 該当する日付列の範囲（最小〜最大）をもう1回のbulk読み取りで取得し、具材名の列と
  // 行ごとに連結する（絶対列位置がずれても、parseChiseSheetRows側は行0から相対的に
  // 日付列を再検出するため問題ない）
  var windowCols = sheet.getRange(1, minColIdx + 1, lastRow, maxColIdx - minColIdx + 1).getDisplayValues();
  var merged = [];
  for (var r = 0; r < lastRow; r++) {
    merged.push([labelCol[r][0]].concat(windowCols[r]));
  }
  return merged;
}

// doGet本体で例外が発生すると、Content-Typeが text/html のGoogleエラーページが
// 返ってしまい、呼び出し元（fetch().json()）ではその他のネットワークエラーと区別が付かず
// 「データが0件だった」ように見えてしまう。これによりanalytics.html等で原因不明の
// 「データがありません」表示につながっていたため、必ずJSONを返すようにラップする。
function doGet(e) {
  try {
    return doGetInner(e);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err && err.message || err), rows: [], plans: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGetInner(e) {
  if (e.parameter && e.parameter.type === "disruptions") {
    return handleDisruptions();
  }

  if (e.parameter && e.parameter.type === "chiseSheet") {
    return handleGetChiseSheet(e.parameter.noCache === "1");
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);

  if (e.parameter && e.parameter.type === "bootstrap") {
    return handleGetBootstrap(ss);
  }

  if (e.parameter && e.parameter.type === "storeSettings") {
    return handleGetStoreSettings(ss, e.parameter.noCache === "1");
  }

  if (e.parameter && e.parameter.type === "monthlyOnigiri") {
    return handleGetMonthlyOnigiri(ss, e.parameter.noCache === "1");
  }

  if (e.parameter && e.parameter.type === "smallSheets") {
    return handleGetSmallSheets(ss, e.parameter.noCache === "1");
  }

  if (e.parameter && e.parameter.type === "tempBinDayCounts") {
    return handleGetTempBinDayCounts(ss);
  }

  if (e.parameter && e.parameter.type === "draft") {
    return handleGetDraft(ss);
  }

  if (e.parameter && e.parameter.type === "draftUpdatedAt") {
    return handleGetDraftUpdatedAt(ss, e.parameter.date);
  }

  if (e.parameter && e.parameter.type === "status") {
    return handleGetStatus(ss);
  }

  if (e.parameter && e.parameter.type === "hourly") {
    // dateパラメータ（yyyy-MM-dd）が指定された場合はその日付の行だけを返す。
    // 実績シートは行数が増え続けるため、当日分の表示だけが目的のindex.htmlは
    // dateを指定して読み取り範囲を絞る（analytics.htmlは全件が必要なので指定しない）。
    // sinceパラメータ（yyyy-MM-dd）は、Zuidの「売れ行き＋天気」で直近の売れ行き(L)を
    // 計算するためだけに最近のデータを取得したいadmin.html・index.html向け
    // （dateが指定されていればdateを優先する）。
    return handleGetHourly(ss, e.parameter.date, e.parameter.since);
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
