import jwt from 'jsonwebtoken';

export function signToken(userId: string, role: string): string {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET as string,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '30d') as any }
  );
}

export function verifyToken(token: string): { userId: string; role: string } {
  return jwt.verify(token, process.env.JWT_SECRET as string) as any;
}