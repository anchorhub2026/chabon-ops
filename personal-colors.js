// メンバーのパーソナルカラー定義。cooking.html・admin.html・production.html等で
// 共通利用できるよう1か所にまとめている（現時点ではcooking.htmlのみ適用）。
// 色を割り当てるメンバーのみ記載する。未記載のメンバー・本部・チセは
// 意図的に色を付けない（personalColorForがnullを返す）。
// bar: 帯・強調用の濃い色 / bg: 背景用の淡い色 / text: bg上で読みやすい濃い文字色
const PERSONAL_COLORS = {
  YUMI:    { bar: "#e8578f", bg: "#fdeaf1", text: "#9c2a5c" }, // ピンク
  MARI:    { bar: "#d9a300", bg: "#fdf6d9", text: "#7a5c00" }, // 黄色
  CHIKAKO: { bar: "#e8762c", bg: "#fdece0", text: "#9c4310" }, // オレンジ
  MIKI:    { bar: "#3f7fd1", bg: "#e8f0fb", text: "#1f4f8c" }, // 青
};

function personalColorFor(name){
  return PERSONAL_COLORS[name] || null;
}
