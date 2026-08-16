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

/* ── 濫用よけ ──
   このURLはアプリのHTML（公開されている）に書かれるので、見つけようと思えば誰でも見つかる。
   URLを拾った第三者に呼ばれても、こちらの請求が青天井にならないよう2つの蓋をしておく。
   ふつうに家計簿として使うぶんには、まず当たらない数字にしてある。 */
var MAX_IMAGE_CHARS = 3000000;  // 送られてきた画像の上限（base64で約2.2MB）
                                // アプリは長辺1280pxに縮めて送るので通常は50万文字以下
var DAILY_LIMIT = 300;          // 1日に読み取れる枚数の上限
                                // 1人で1日300枚は使わない。足りなければこの数字を上げる

/* 合言葉。アプリ側の OCR_TOKEN と同じ文字列にする。
   このURLだけを拾って自動で叩いてくる相手を弾くためのもの。
   アプリのHTMLは公開されているので、本気で探せば読めます。そこは承知のうえで、
   本当の歯止めは上の DAILY_LIMIT と、Google Cloud 側のクォータ上限です。
   空文字のままなら照合しません（動作確認中はこれでよい）。 */
var SHARED_TOKEN = '';

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
    if (e.postData.contents.length > MAX_IMAGE_CHARS + 10000) {
      return reply({ ok: false, message: '写真が大きすぎます。撮り直してください' });
    }
    var req = JSON.parse(e.postData.contents);
    if (SHARED_TOKEN && req.token !== SHARED_TOKEN) {
      return reply({ ok: false, message: 'アクセスが許可されていません' });
    }
    if (!req.image || typeof req.image !== 'string') {
      return reply({ ok: false, message: '写真が届きませんでした' });
    }
    if (req.image.length > MAX_IMAGE_CHARS) {
      return reply({ ok: false, message: '写真が大きすぎます。撮り直してください' });
    }
    // base64以外の文字が混じっているものは受け付けない
    if (!/^[A-Za-z0-9+/=\s]+$/.test(req.image)) {
      return reply({ ok: false, message: '写真の形式が正しくありません' });
    }
    if (!withinDailyLimit()) {
      return reply({ ok: false, message: '本日の読み取り上限に達しました。手入力をお使いください' });
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

    // キーはURLではなくヘッダで送る。URLに入れると、通信エラーの文言にキーごと
    // 混ざって実行ログに残ることがあるため。
    var res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );

    var code = res.getResponseCode();
    if (code !== 200) {
      // 失敗の中身はサーバーのログにだけ残す（利用者には見せない）
      console.error('Gemini error ' + code + ': ' + mask(res.getContentText().slice(0, 500)));
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
    console.error(mask(String(err)));
    return reply({ ok: false, message: '読み取りに失敗しました' });
  }
}

/* ログに残す前に、万一まぎれ込んだAPIキーを伏せる */
function mask(text) {
  return String(text)
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, 'AIza***')
    .replace(/key=[^&\s"']+/g, 'key=***');
}

/* 動作確認用。ブラウザでURLを開いたときに出る */
function doGet() {
  return ContentService
    .createTextOutput('やさしい家計簿 レシート読み取り中継：稼働中')
    .setMimeType(ContentService.MimeType.TEXT);
}

/* 1日あたりの読み取り回数を数える。上限を超えたら false を返す。
   日付が変わったら自動で0に戻る（古いカウンタが溜まらないよう1件で持ち回す）。 */
function withinDailyLimit() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);            // 同時に来ても二重に数えないように
  } catch (e) {
    return true;                    // 数えられないときは通す（利用者を止めない側に倒す）
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var usage;
    try { usage = JSON.parse(props.getProperty('USAGE') || '{}'); } catch (e) { usage = {}; }
    if (usage.date !== today) usage = { date: today, count: 0 };
    if (usage.count >= DAILY_LIMIT) {
      console.warn('1日の上限に達しました: ' + today + ' / ' + usage.count + '件');
      return false;
    }
    usage.count++;
    props.setProperty('USAGE', JSON.stringify(usage));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
