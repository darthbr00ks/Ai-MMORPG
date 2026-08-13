import { signIn } from '@/lib/auth';

export default function SignInPage() {
  return (
    <div className="max-w-md mx-auto mt-20 space-y-6">
      <h2 className="text-2xl font-bold text-center">Sign in to AI World</h2>
      <p className="text-gray-400 text-center">
        Claim an AI character and give it a directive.
      </p>
      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo: '/characters' });
        }}
      >
        <button
          type="submit"
          className="w-full bg-white text-gray-900 font-medium py-3 rounded hover:bg-gray-100 transition-colors"
        >
          Continue with Google
        </button>
      </form>
    </div>
  );
}
