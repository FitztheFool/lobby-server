import { SignJWT } from 'jose';

const SOCKET_SECRET = new TextEncoder().encode(process.env.INTERNAL_API_KEY!);

export async function createBotToken(userId: string, username: string): Promise<string> {
    return new SignJWT({ username })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(SOCKET_SECRET);
}
