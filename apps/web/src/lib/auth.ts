import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getDb, schema } from '@ai-world/database';
import { DrizzleAdapter } from '@auth/drizzle-adapter';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: schema.users as never,
    accountsTable: schema.accounts as never,
    sessionsTable: schema.sessions as never,
    verificationTokensTable: schema.verificationTokens as never,
  }),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),
  ],
  session: {
    strategy: 'database',
  },
  pages: {
    signIn: '/auth/signin',
  },
});
