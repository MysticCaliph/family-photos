/**
 * Telegram Family Photo & Video Gallery Backend
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

      // 4. API: List all media (photos & videos)
      if (request.method === 'GET' && pathname === '/api/photos') {
        const providedCode = (searchParams.get('code') || request.headers.get('x-passcode') || '').trim();
        if (env.FAMILY_PASSCODE && providedCode !== String(env.FAMILY_PASSCODE).trim()) {
          return jsonResponse({ ok: false, error: 'Unauthorized: Invalid passcode' }, 401);
        }

        const query = await env.DB.prepare(
          'SELECT * FROM photos ORDER BY created_at DESC'
        ).all();

        // Strip leading -100 to generate t.me/c/<chat_link_id>/<message_id> direct deep links
        const chatLinkId = env.ALLOWED_CHAT_ID ? String(env.ALLOWED_CHAT_ID).replace(/^-100/, '') : '';

        const results = (query.results || []).map(item => ({
          ...item,
          chat_link_id: chatLinkId,
        }));

        return new Response(JSON.stringify(results), {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }

      // 5. API: Proxy / Stream Telegram Media Files (Supports HTTP Range for video streaming)
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
          return errorResponse(
            fileData.description || 'File not found in Telegram (files over 20MB must be opened directly in Telegram)',
            404
          );
        }

        const filePath = fileData.result.file_path;
        const tgDownloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;

        // Forward Range headers for video seek/scrub streaming
        const rangeHeader = request.headers.get('range');
        const tgHeaders = {};
        if (rangeHeader) {
          tgHeaders['Range'] = rangeHeader;
        }

        // Fetch file stream from Telegram
        const fileRes = await fetch(tgDownloadUrl, { headers: tgHeaders });
        if (!fileRes.ok && fileRes.status !== 206) {
          return errorResponse('Failed to fetch file stream from Telegram', fileRes.status);
        }

        // Prepare response headers
        const responseHeaders = new Headers(CORS_HEADERS);
        responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
        responseHeaders.set('Accept-Ranges', 'bytes');

        // Detect or infer content-type
        let contentType = fileRes.headers.get('content-type');
        const lowerPath = filePath.toLowerCase();
        if (!contentType || contentType === 'application/octet-stream') {
          if (lowerPath.endsWith('.mp4')) contentType = 'video/mp4';
          else if (lowerPath.endsWith('.webm')) contentType = 'video/webm';
          else if (lowerPath.endsWith('.mov')) contentType = 'video/quicktime';
          else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) contentType = 'image/jpeg';
          else if (lowerPath.endsWith('.png')) contentType = 'image/png';
        }
        if (contentType) {
          responseHeaders.set('Content-Type', contentType);
        }

        const contentLength = fileRes.headers.get('content-length');
        if (contentLength) {
          responseHeaders.set('Content-Length', contentLength);
        }

        const contentRange = fileRes.headers.get('content-range');
        if (contentRange) {
          responseHeaders.set('Content-Range', contentRange);
        }

        // Attachment download handling
        if (searchParams.get('dl') === '1') {
          const rawName = searchParams.get('name') || filePath.split('/').pop() || 'media';
          const safeName = rawName.replace(/["\r\n]/g, '_');
          responseHeaders.set('Content-Disposition', `attachment; filename="${safeName}"`);
        }

        return new Response(fileRes.body, {
          status: fileRes.status,
          headers: responseHeaders,
        });
      }

      // 6. POST /webhook: Handle incoming Telegram events
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
        const messageId = msg.message_id || 0;

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

        // Support replying /delete to remove media from D1
        const isDeleteCommand = /^\/delete(?:@\w+)?$/i.test(textContent);
        if (isDeleteCommand && msg.reply_to_message) {
          const reply = msg.reply_to_message;
          const replyPhoto = reply.photo && reply.photo.length > 0
            ? reply.photo[reply.photo.length - 1]
            : null;
          const replyVideo = reply.video || reply.video_note;
          const replyDoc = reply.document;

          const targetUniqueId =
            replyPhoto?.file_unique_id ||
            replyVideo?.file_unique_id ||
            replyDoc?.file_unique_id ||
            null;
          const targetFileId =
            replyPhoto?.file_id ||
            replyVideo?.file_id ||
            replyDoc?.file_id ||
            null;

          if (targetUniqueId || targetFileId) {
            await env.DB.prepare(`
              DELETE FROM photos
              WHERE file_unique_id = ? OR full_file_id = ? OR thumb_file_id = ?
            `).bind(targetUniqueId || '', targetFileId || '', targetFileId || '').run();

            return jsonResponse({ ok: true, action: 'media_deleted' });
          }

          return jsonResponse({ ok: true, action: 'delete_target_not_found' });
        }

        // Extract photo, video, video_note, or document media
        let thumb_file_id = '';
        let full_file_id = null;
        let file_unique_id = null;
        let file_size = 0;
        let file_name = null;
        let media_type = 'photo';
        let duration = 0;

        if (Array.isArray(msg.photo) && msg.photo.length > 0) {
          // 1. Standard Telegram Photo
          media_type = 'photo';
          duration = 0;
          const thumbPhoto = msg.photo.length > 1 ? msg.photo[1] : msg.photo[0];
          const fullPhoto = msg.photo[msg.photo.length - 1];

          thumb_file_id = thumbPhoto.file_id;
          full_file_id = fullPhoto.file_id;
          file_unique_id = fullPhoto.file_unique_id;
          file_size = fullPhoto.file_size || 0;
          file_name = `photo_${msg.date || Math.floor(Date.now() / 1000)}_${file_unique_id.slice(-6)}.jpg`;
        } else if (msg.video) {
          // 2. Standard Telegram Video (NO 20 MB restriction for database capture)
          const vid = msg.video;
          media_type = 'video';
          thumb_file_id = vid.thumbnail?.file_id || vid.thumb?.file_id || '';
          full_file_id = vid.file_id;
          file_unique_id = vid.file_unique_id;
          file_size = vid.file_size || 0;
          duration = vid.duration || 0;
          file_name = vid.file_name || `video_${msg.date || Math.floor(Date.now() / 1000)}_${file_unique_id.slice(-6)}.mp4`;
        } else if (msg.video_note) {
          // 3. Telegram Round Video Note
          const vn = msg.video_note;
          media_type = 'video';
          thumb_file_id = vn.thumbnail?.file_id || vn.thumb?.file_id || '';
          full_file_id = vn.file_id;
          file_unique_id = vn.file_unique_id;
          file_size = vn.file_size || 0;
          duration = vn.duration || 0;
          file_name = `video_note_${msg.date || Math.floor(Date.now() / 1000)}_${file_unique_id.slice(-6)}.mp4`;
        } else if (msg.document && msg.document.mime_type) {
          const doc = msg.document;
          const mime = doc.mime_type.toLowerCase();

          if (mime.startsWith('video/')) {
            // 4. Video Document / File (NO size limit)
            media_type = 'video';
            thumb_file_id = doc.thumbnail?.file_id || doc.thumb?.file_id || '';
            full_file_id = doc.file_id;
            file_unique_id = doc.file_unique_id;
            file_size = doc.file_size || 0;
            duration = 0;
            file_name = doc.file_name || `video_${file_unique_id.slice(-6)}.mp4`;
          } else if (mime.startsWith('image/')) {
            // 5. Image Document / File (NO size limit)
            media_type = 'photo';
            thumb_file_id = doc.thumbnail?.file_id || doc.thumb?.file_id || doc.file_id;
            full_file_id = doc.file_id;
            file_unique_id = doc.file_unique_id;
            file_size = doc.file_size || 0;
            duration = 0;
            file_name = doc.file_name || `image_${file_unique_id.slice(-6)}.jpg`;
          }
        }

        // If no supported photo or video found, finish gracefully
        if (!full_file_id || !file_unique_id) {
          return jsonResponse({ ok: true, ignored: true, reason: 'No supported media file' });
        }

        // Determine current topic name for this media
        let topicName = 'General';
        if (topicId === 0) {
          topicName = 'General';
        } else {
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

        // Insert into photos table with media_type, duration, and message_id
        await env.DB.prepare(`
          INSERT OR IGNORE INTO photos (
            file_unique_id, thumb_file_id, full_file_id, file_name,
            file_size, caption, sender, topic_id, topic_name, created_at,
            media_type, duration, message_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          createdAt,
          media_type,
          duration,
          messageId
        ).run();

        return jsonResponse({ ok: true, action: 'media_saved', file_unique_id, media_type });
      }

      // Fallback 404
      return errorResponse('Endpoint not found', 404);
    } catch (err) {
      return errorResponse(err.message || 'Internal Server Error', 500);
    }
  },
};
