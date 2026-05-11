/* @meta
{
  "name": "instagram/send-message",
  "description": "发送私信 (send DM text message)",
  "domain": "www.instagram.com",
  "args": {
    "text": {"required": true, "description": "消息内容"},
    "thread_id": {"required": false, "description": "线程 ID（从 messages 结果获取，与 user_ids 二选一）"},
    "user_ids": {"required": false, "description": "接收者 pk ID（新建对话时使用，与 thread_id 二选一）"}
  },
  "capabilities": ["network"],
  "readOnly": false,
  "example": "bb-browser site instagram/send-message --thread_id 2022105405850613 --text \"Hello!\""
}
*/

async function(args) {
  if (!args.text) return {error: 'Missing argument: text', hint: '请提供消息内容'};
  if (!args.thread_id && !args.user_ids) return {error: 'Missing argument', hint: '请提供 thread_id（已有对话）或 user_ids（新对话）'};

  var csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
  if (!csrfMatch) return {error: 'Not logged in', hint: '请先登录 Instagram', action: 'bb-browser open https://www.instagram.com/accounts/login/'};
  var csrf = csrfMatch[1];

  var fbDtsg = null;
  try { fbDtsg = require('DTSGInitialData').token; } catch(e) {}
  if (!fbDtsg) return {error: 'No fb_dtsg token', hint: '请刷新页面后重试', action: 'bb-browser refresh'};

  var lsd = null;
  try { lsd = require('LSD').token; } catch(e) {}
  if (!lsd) try { lsd = require('LSDToken').token; } catch(e) {}

  // Resolve thread_v2_id (ig_thread_igid) needed by the send mutation.
  // Input can be: user_ids (new thread), thread_v2_id, or thread_fbid (from URL).
  // We always go through create_group_thread which returns thread_v2_id for any input.
  var threadIgid = null;

  if (args.user_ids) {
    // New conversation by user IDs
    var uids = args.user_ids.split(',').map(function(id) { return id.trim(); });
    var createBody = new URLSearchParams();
    createBody.append('recipient_users', JSON.stringify(uids));
    var createResp = await fetch('/api/v1/direct_v2/create_group_thread/', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf, 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest'},
      body: createBody.toString()
    });
    if (!createResp.ok) return {error: 'Failed to create thread', hint: 'HTTP ' + createResp.status};
    var createData = await createResp.json();
    threadIgid = createData.thread_v2_id || createData.thread_id;
  } else if (args.thread_id) {
    // Input could be: thread_v2_id, or interop_fbid from URL (/direct/t/117711076288000/)
    // Look up inbox to match by thread_v2_id or user's interop_messaging_user_fbid
    var inboxResp = await fetch('/api/v1/direct_v2/inbox/?limit=20', {
      credentials: 'include',
      headers: {'X-CSRFToken': csrf, 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest'}
    });
    if (inboxResp.ok) {
      var inboxData = await inboxResp.json();
      var threads = (inboxData.inbox && inboxData.inbox.threads) || [];
      for (var i = 0; i < threads.length; i++) {
        var t = threads[i];
        if (String(t.thread_v2_id) === String(args.thread_id)) {
          threadIgid = t.thread_v2_id;
          break;
        }
        // Match by user's interop_messaging_user_fbid (used in DM URLs)
        var users = t.users || [];
        for (var j = 0; j < users.length; j++) {
          if (String(users[j].interop_messaging_user_fbid) === String(args.thread_id)) {
            threadIgid = t.thread_v2_id;
            break;
          }
        }
        if (threadIgid) break;
      }
    }
    if (!threadIgid) threadIgid = args.thread_id;
  }

  if (!threadIgid) return {error: 'Could not determine thread ID'};

  var docId;
  ['IGDirectTextSendMutation', 'IGDirectTextSendMutation.graphql'].forEach(function(name) {
    try { var mod = require(name); if (mod && mod.params && mod.params.id && !docId) docId = mod.params.id; } catch(e) {}
  });
  if (!docId) docId = '26911679871773184';

  // Generate offline_threading_id (random large number like snowflake)
  var offlineId = String(Math.floor(Math.random() * 9000000000000000000) + 1000000000000000000);

  var variables = {
    ig_thread_igid: String(threadIgid),
    offline_threading_id: offlineId,
    recipient_igids: null,
    replied_to_client_context: null,
    replied_to_item_id: null,
    reply_to_message_id: null,
    sampled: null,
    text: {sensitive_string_value: args.text},
    mentions: [],
    mentioned_user_ids: [],
    commands: null,
    forwarded_from_thread_id: null,
    is_forwarded_from_own_message: null,
    send_attribution: 'igd_web_chat_tab:in_thread'
  };

  var body = new URLSearchParams();
  body.append('__d', 'www');
  body.append('__user', '0');
  body.append('__a', '1');
  body.append('__comet_req', '7');
  body.append('fb_dtsg', fbDtsg);
  if (lsd) body.append('lsd', lsd);
  body.append('fb_api_caller_class', 'RelayModern');
  body.append('fb_api_req_friendly_name', 'IGDirectTextSendMutation');
  body.append('server_timestamps', 'true');
  body.append('variables', JSON.stringify(variables));
  body.append('doc_id', docId);

  var headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-CSRFToken': csrf,
    'X-IG-App-ID': '1217981644879628',
    'X-Requested-With': 'XMLHttpRequest',
    'X-FB-Friendly-Name': 'IGDirectTextSendMutation'
  };
  if (lsd) headers['X-FB-LSD'] = lsd;

  var resp = await fetch('/api/graphql', {
    method: 'POST', credentials: 'include', headers: headers, body: body.toString()
  });

  if (!resp.ok) return {error: 'HTTP ' + resp.status, hint: '发送失败'};
  var d = await resp.json();

  if (d.errors && d.errors.length > 0) {
    return {error: d.errors[0].message || 'Send failed', detail: JSON.stringify(d.errors).substring(0, 200)};
  }

  return {
    status: 'ok',
    thread_id: threadIgid,
    text: args.text,
    offline_threading_id: offlineId
  };
}
