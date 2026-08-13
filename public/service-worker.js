// Service Worker สำหรับ Push Notification เท่านั้น (ไม่มี Offline Caching)

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'มีข้อความใหม่';
    const options = {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: data.url || '/dashboard' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// กดที่ตัวแจ้งเตือนแล้วพาไปเปิดหน้าแชท
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes('/dashboard') && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(event.notification.data.url);
        })
    );
});