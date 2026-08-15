/**
 * やさしい家計簿 － レシート読み取りの中継サーバー
 *
 * 役割：アプリから送られてきたレシート写真を Gemini に渡し、
 *       「お店・合計金額・日付・分類」だけを取り出して返す。
 *
 * なぜ中継するか：APIキーをアプリ（公開されているHTML）に書くと誰でも使えてしまう。
 *                 キーはこのGAS側の「スクリプト プロパティ」に置き、外には出さない。
 *
 * 写真は保存しない。読み取ったその場でGeminiに渡して捨てる。
 *
 * ── 準備 ──
 * 1. 拡張機能 → Apps Script でこのファイルを貼る
 * 2. 歯車（プロジェクトの設定）→ スクリプト プロパティ
 *      名前: GEMINI_API_KEY   値: 取得したAPIキー
 * 3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      次のユーザーとして実行: 自分
 *      アクセスできるユーザー: 全員
 * 4. 出てきた /exec で終わるURLを index.html の OCR_URL に貼る
 * ※ コードを直したら、必ず「デプロイを管理」→ 編集 → バージョン「新バージョン」で更新する
 */

var MODEL = 'gemini-flash-latest';

var PROMPT = [
  'あなたはレシートを読み取る係です。渡された画像は日本のお店のレシートです。',
  '次の項目だけを読み取り、JSONで返してください。',
  '',
  '- shop: お店の名前（短く。分からなければ空文字）',
  '- total: 支払った合計金額（数字のみ。円マークやカンマは付けない）',
  '  ※「合計」「お買上げ計」など最終的に支払った額。小計・お預り・お釣り・ポイントは選ばない。',
  '  ※軽減税率などで複数の合計が並ぶ場合は、いちばん大きい支払総額を選ぶ。',
  '- date: レシートの日付（YYYY-MM-DD形式。読めなければ空文字）',
  '- category: 次から1つだけ選ぶ',
  '    food   … スーパー・食料品店での買い物',
  '    eatout … 飲食店・カフェ・居酒屋など、その場で食べた支払い',
  '    daily  … ドラッグストア・日用品・文具',
  '    fun    … 書店・ゲーム・映画・娯楽',
  '    trans  … ガソリン・駐車場・交通費',
  '    other  … 上のどれにも当てはまらない',
  '',
  'レシート以外の画像だった場合は total を 0 にしてください。'
].join('\n');

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply({ ok: false, message: '写真が届きませんでした' });
    }
    var req = JSON.parse(e.postData.contents);
    if (!req.image) {
      return reply({ ok: false, message: '写真が届きませんでした' });
    }

    var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) {
      return reply({ ok: false, message: 'サーバーの設定が未完了です（APIキー未登録）' });
    }

    var payload = {
      contents: [{
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: req.image } }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            shop:     { type: 'STRING' },
            total:    { type: 'INTEGER' },
            date:     { type: 'STRING' },
            category: { type: 'STRING' }
          },
          required: ['shop', 'total', 'date', 'category']
        }
      }
    };

    var res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + encodeURIComponent(key),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );

    var code = res.getResponseCode();
    if (code !== 200) {
      // 失敗の中身はサーバーのログにだけ残す（利用者には見せない）
      console.error('Gemini error ' + code + ': ' + res.getContentText().slice(0, 500));
      return reply({ ok: false, message: '読み取りサービスに接続できませんでした' });
    }

    var body = JSON.parse(res.getContentText());
    var text = body.candidates &&
               body.candidates[0] &&
               body.candidates[0].content &&
               body.candidates[0].content.parts &&
               body.candidates[0].content.parts[0] &&
               body.candidates[0].content.parts[0].text;
    if (!text) {
      return reply({ ok: false, message: 'レシートを読み取れませんでした' });
    }

    var out = JSON.parse(text);
    return reply({
      ok: true,
      shop: String(out.shop || '').slice(0, 40),
      total: parseInt(out.total, 10) || 0,
      date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '',
      category: ['food', 'eatout', 'daily', 'fun', 'trans', 'other'].indexOf(out.category) >= 0
                ? out.category : 'other'
    });

  } catch (err) {
    console.error(err);
    return reply({ ok: false, message: '読み取りに失敗しました' });
  }
}

/* 動作確認用。ブラウザでURLを開いたときに出る */
function doGet() {
  return ContentService
    .createTextOutput('やさしい家計簿 レシート読み取り中継：稼働中')
    .setMimeType(ContentService.MimeType.TEXT);
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
