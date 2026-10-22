/**
 * Telegram Family Photo Gallery Backend
 * Cloudflare Worker + Cloudflare D1
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight Requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    try {
      // 2. Health check route
      if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        return jsonResponse({ ok: true, service: 'family-photo-api', status: 'operational' });
      }

      // 3. API: Verify Passcode
      if (request.method === 'GET' && pathname === '/api/verify') {
        const providedCode = (searchParams.get('code') || request.headers.get('x-passcode') || '').trim();
        if (!env.FAMILY_PASSCODE || providedCode === String(env.FAMILY_PASSCODE).trim()) {
          return jsonResponse({ ok: true, verified: true });
        }
        return jsonResponse({ ok: false, error: 'Unauthorized: Invalid passcode' }, 401);
      }

      // 4. API: List all photos
      if (request.method === 'GET' && pathname === '/api/photos') {
        const providedCode = (searchParams.get('code') || request.headers.get('x-passcode') || '').trim();
        if (env.FAMILY_PASSCODE && providedCode !== String(env.FAMILY_PASSCODE).trim()) {
          return jsonResponse({ ok: false, error: 'Unauthorized: Invalid passcode' }, 401);
        }

        const query = await env.DB.prepare(
          'SELECT * FROM photos ORDER BY created_at DESC'
        ).all();

        return new Response(JSON.stringify(query.results || []), {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }

      // 4. API: Proxy / Stream Telegram Media Files
      if (request.method === 'GET' && pathname.startsWith('/file/')) {
        const fileId = pathname.slice('/file/'.length).trim();
        if (!fileId) {
          return errorResponse('Missing file_id', 400);
        }

        if (!env.BOT_TOKEN) {
          return errorResponse('BOT_TOKEN is not configured', 500);
        }

        // Call Telegram getFile API to get file_path
        const getFileUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const getFileRes = await fetch(getFileUrl);
        const fileData = await getFileRes.json();

        if (!fileData.ok || !fileData.result?.file_path) {
          return errorResponse('File not found in Telegram', 404);
        }

        const filePath = fileData.result.file_path;
        const tgDownloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;

        // Fetch file binary stream from Telegram
        const fileRes = await fetch(tgDownloadUrl);
        if (!fileRes.ok) {
          return errorResponse('Failed to fetch file stream from Telegram', fileRes.status);
        }

        // Prepare response headers
        const responseHeaders = new Headers(CORS_HEADERS);
        responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');

        const contentType = fileRes.headers.get('content-type');
        if (contentType) {
          responseHeaders.set('Content-Type', contentType);
        }
        const contentLength = fileRes.headers.get('content-length');
        if (contentLength) {
          responseHeaders.set('Content-Length', contentLength);
        }

        // Attachment download handling
        if (searchParams.get('dl') === '1') {
          const rawName = searchParams.get('name') || filePath.split('/').pop() || 'photo.jpg';
          const safeName = rawName.replace(/["\r\n]/g, '_');
          responseHeaders.set('Content-Disposition', `attachment; filename="${safeName}"`);
        }

        return new Response(fileRes.body, {
          status: 200,
          headers: responseHeaders,
        });
      }

      // 5. POST /webhook: Handle incoming Telegram events
      if (request.method === 'POST' && pathname === '/webhook') {
        let update;
        try {
          update = await request.json();
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }

        const msg = update.message || update.channel_post || update.edited_message;
        if (!msg || !msg.chat) {
          return jsonResponse({ ok: true, ignored: true, reason: 'No message or chat payload' });
        }

        // Verify Allowed Chat ID
        if (env.ALLOWED_CHAT_ID && String(msg.chat.id) !== String(env.ALLOWED_CHAT_ID)) {
          return jsonResponse({ ok: true, ignored: true, reason: 'Chat ID not permitted' });
        }

        const topicId = msg.message_thread_id || 0;

        // Detect topic name if present in metadata
        const detectedTopicName =
          msg.forum_topic_created?.name ||
          msg.forum_topic_edited?.name ||
          msg.reply_to_message?.forum_topic_created?.name ||
          null;

        if (detectedTopicName) {
          // Upsert into topics
          await env.DB.prepare(`
            INSERT INTO topics (topic_id, topic_name)
            VALUES (?, ?)
            ON CONFLICT(topic_id) DO UPDATE SET topic_name = excluded.topic_name
          `).bind(topicId, detectedTopicName).run();

          // Update existing rows in photos where topic_id matches
          await env.DB.prepare(`
            UPDATE photos SET topic_name = ? WHERE topic_id = ?
          `).bind(detectedTopicName, topicId).run();
        }

        const textContent = (msg.text || msg.caption || '').trim();

        // Support command: /name <New Topic Name>
        const nameMatch = textContent.match(/^\/name(?:@\w+)?\s+(.+)$/is);
        if (nameMatch) {
          const newTopicName = nameMatch[1].trim();
          if (newTopicName) {
            await env.DB.prepare(`
              INSERT INTO topics (topic_id, topic_name)
              VALUES (?, ?)
              ON CONFLICT(topic_id) DO UPDATE SET topic_name = excluded.topic_name
            `).bind(topicId, newTopicName).run();

            await env.DB.prepare(`
              UPDATE photos SET topic_name = ? WHERE topic_id = ?
            `).bind(newTopicName, topicId).run();
          }

          return jsonResponse({ ok: true, action: 'topic_renamed', topic_id: topicId, topic_name: newTopicName });
        }

        // Support replying /delete to a photo to remove it from D1
        const isDeleteCommand = /^\/delete(?:@\w+)?$/i.test(textContent);
        if (isDeleteCommand && msg.reply_to_message) {
          const reply = msg.reply_to_message;
          const replyPhoto = reply.photo && reply.photo.length > 0
            ? reply.photo[reply.photo.length - 1]
            : null;
          const replyDoc = reply.document;

          const targetUniqueId = replyPhoto?.file_unique_id || replyDoc?.file_unique_id || null;
          const targetFileId = replyPhoto?.file_id || replyDoc?.file_id || null;

          if (targetUniqueId || targetFileId) {
            await env.DB.prepare(`
              DELETE FROM photos
              WHERE file_unique_id = ? OR full_file_id = ? OR thumb_file_id = ?
            `).bind(targetUniqueId || '', targetFileId || '', targetFileId || '').run();

            return jsonResponse({ ok: true, action: 'photo_deleted' });
          }

          return jsonResponse({ ok: true, action: 'delete_target_not_found' });
        }

        // Extract photo or uncompressed image document
        let thumb_file_id = null;
        let full_file_id = null;
        let file_unique_id = null;
        let file_size = 0;
        let file_name = null;

        if (Array.isArray(msg.photo) && msg.photo.length > 0) {
          // Standard Telegram photo
          // thumb: photo[1] or photo[0]
          const thumbPhoto = msg.photo.length > 1 ? msg.photo[1] : msg.photo[0];
          // full: photo[photo.length - 1]
          const fullPhoto = msg.photo[msg.photo.length - 1];

          thumb_file_id = thumbPhoto.file_id;
          full_file_id = fullPhoto.file_id;
          file_unique_id = fullPhoto.file_unique_id;
          file_size = fullPhoto.file_size || 0;
          file_name = `photo_${msg.date || Math.floor(Date.now() / 1000)}_${file_unique_id.slice(-6)}.jpg`;
        } else if (
          msg.document &&
          msg.document.mime_type &&
          msg.document.mime_type.startsWith('image/') &&
          (msg.document.file_size || 0) <= 20971520 // <= 20MB
        ) {
          // Uncompressed image file
          const doc = msg.document;
          thumb_file_id = doc.thumbnail?.file_id || doc.file_id;
          full_file_id = doc.file_id;
          file_unique_id = doc.file_unique_id;
          file_size = doc.file_size || 0;
          file_name = doc.file_name || `document_${file_unique_id.slice(-6)}.jpg`;
        }

        // If no valid photo/document found, finish successfully
        if (!full_file_id || !file_unique_id) {
          return jsonResponse({ ok: true, ignored: true, reason: 'No supported photo or image document' });
        }

        // Determine current topic name for this photo
        let topicName = 'General';
        if (topicId === 0) {
          topicName = 'General';
        } else {
          // Query topics table first
          const topicRow = await env.DB.prepare(
            'SELECT topic_name FROM topics WHERE topic_id = ?'
          ).bind(topicId).first();

          if (topicRow?.topic_name) {
            topicName = topicRow.topic_name;
          } else if (detectedTopicName) {
            topicName = detectedTopicName;
          } else {
            topicName = 'General';
          }
        }

        // Determine sender name
        let sender = 'Family Member';
        if (msg.from) {
          sender = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') ||
            msg.from.username ||
            'Family Member';
        } else if (msg.sender_chat?.title) {
          sender = msg.sender_chat.title;
        }

        const caption = msg.caption || '';
        const createdAt = msg.date ? msg.date * 1000 : Date.now();

        // Insert into photos with INSERT OR IGNORE
        await env.DB.prepare(`
          INSERT OR IGNORE INTO photos (
            file_unique_id, thumb_file_id, full_file_id, file_name,
            file_size, caption, sender, topic_id, topic_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          file_unique_id,
          thumb_file_id,
          full_file_id,
          file_name,
          file_size,
          caption,
          sender,
          topicId,
          topicName,
          createdAt
        ).run();

        return jsonResponse({ ok: true, action: 'photo_saved', file_unique_id });
      }

      // Fallback 404
      return errorResponse('Endpoint not found', 404);
    } catch (err) {
      return errorResponse(err.message || 'Internal Server Error', 500);
    }
  },
};

