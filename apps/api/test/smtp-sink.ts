import { createServer, type Socket } from 'node:net';

/** A loopback-only SMTP receiver. It never relays or contacts an external provider. */
export async function smtpSink() {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  let rejectNext = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    socket.write('220 localhost RentFlow test SMTP\r\n');
    let buffer = '';
    let data: string[] | null = null;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            messages.push(data.join('\r\n'));
            data = null;
            socket.write('250 Message accepted\r\n');
          } else data.push(line.replace(/^\.\./, '.'));
        } else if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^HELO /i.test(line)) socket.write('250 localhost\r\n');
        else if (/^MAIL FROM:/i.test(line) && rejectNext) {
          rejectNext = false;
          socket.write('451 Temporary local failure\r\n');
        } else if (/^(MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) socket.write('250 OK\r\n');
        else if (/^DATA$/i.test(line)) { data = []; socket.write('354 End with a dot\r\n'); }
        else if (/^QUIT$/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('500 Unsupported test command\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP receiver did not bind');
  return {
    url: `smtp://127.0.0.1:${address.port}`,
    messages,
    rejectOnce: () => { rejectNext = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function mailText(raw: string): string {
  const separator = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, separator);
  const body = raw.slice(separator + 4);
  if (/Content-Transfer-Encoding: base64/i.test(headers)) return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
  if (/Content-Transfer-Encoding: quoted-printable/i.test(headers))
    return body.replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return body;
}
