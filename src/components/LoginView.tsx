import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, LogIn, ShieldCheck, User } from 'lucide-react';
import {
  bootstrapFirstAdmin,
  isBootstrapNeeded,
  signInWithUsernamePassword,
} from '../lib/firestoreService.ts';
import { BrandLogo } from './BrandLogo.tsx';

interface LoginViewProps {
  checkingAuth: boolean;
  authError: string | null;
  onClearError: () => void;
}

const FIREBASE_PROVIDERS_URL =
  'https://console.firebase.google.com/u/0/project/crm-desk-1a741/authentication/providers';

export const LoginView: React.FC<LoginViewProps> = ({
  checkingAuth,
  authError,
  onClearError,
}) => {
  const [bootstrapNeeded, setBootstrapNeeded] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [mode, setMode] = useState<'login' | 'setup'>('login');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    isBootstrapNeeded()
      .then((needed) => {
        if (!active) return;
        setBootstrapNeeded(needed);
        if (needed) {
          setMode('setup');
        }
      })
      .finally(() => {
        if (active) setCheckingBootstrap(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const displayError = localError || authError;
  const isProviderDisabledError = Boolean(displayError?.includes('operation-not-allowed'));

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    onClearError();
    setLocalError(null);
    setSubmitting(true);
    try {
      await signInWithUsernamePassword(username, password);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'ไม่สามารถเข้าสู่ระบบได้');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBootstrapSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    onClearError();
    setLocalError(null);
    setSubmitting(true);
    try {
      await bootstrapFirstAdmin({
        username,
        password,
        display_name: displayName,
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'ไม่สามารถสร้างบัญชีผู้ดูแลระบบได้');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Brand & Operations Context Panel */}
      <div className="lg:w-5/12 bg-slate-900 text-slate-100 p-8 lg:p-14 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <BrandLogo size="lg" />
            <div className="text-xl font-bold tracking-tight text-white">CRM Desk</div>
          </div>
          <p className="mt-2.5 text-sm text-slate-400">
            ระบบบริหารจัดการเคส To-Do List และติดตามกำหนด SLA แบบเรียลไทม์
          </p>
        </div>

        <div className="my-12 lg:my-0 space-y-8">
          <div>
            <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight text-white text-balance leading-snug">
              ติดตามทุกเคสค้างและกำหนด SLA ของแต่ละแผนกได้ในหน้าเดียว
            </h1>
            <p className="mt-4 text-sm text-slate-300 leading-relaxed max-w-md">
              บันทึกเลขเคส, ID SHOP และรายละเอียดปัญหา พร้อมซิงก์ข้อมูลถาวรแบบเรียลไทม์บนคลาวด์
            </p>
          </div>

          <div className="border-t border-slate-800 pt-6 grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
            <div>
              <div className="font-semibold text-white">Admin</div>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                สร้างบัญชีพนักงานด้วย Username / Password และจัดการทีม
              </p>
            </div>
            <div>
              <div className="font-semibold text-white">TL (หัวหน้าทีม)</div>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                ตรวจสอบ แก้ไขข้อมูล และดูแดชบอร์ดภาพรวมทุกแผนก
              </p>
            </div>
            <div>
              <div className="font-semibold text-white">Agent</div>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                ติดตามและจัดการเคสเฉพาะภายในทีม/แผนกของตนเอง
              </p>
            </div>
          </div>
        </div>

        <div className="text-xs text-slate-500">
          รองรับแผนก Line OA · Call · Email · Social Media และทีมเพิ่มเติมที่กำหนดเอง
        </div>
      </div>

      {/* Right Authentication Panel */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8 space-y-6">
          {checkingAuth || checkingBootstrap ? (
            <div className="space-y-4 py-8">
              <div className="h-6 bg-slate-100 rounded w-1/2 animate-pulse" />
              <div className="h-4 bg-slate-100 rounded w-3/4 animate-pulse" />
              <div className="h-11 bg-slate-100 rounded mt-6 animate-pulse" />
            </div>
          ) : (
            <>
              {bootstrapNeeded && (
                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('setup');
                      onClearError();
                      setLocalError(null);
                    }}
                    className={`px-3 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      mode === 'setup'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    ตั้งค่า Admin ครั้งแรก
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      onClearError();
                      setLocalError(null);
                    }}
                    className={`px-3 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      mode === 'login'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    เข้าสู่ระบบ
                  </button>
                </div>
              )}

              {mode === 'setup' && bootstrapNeeded ? (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-blue-700 text-xs font-semibold">
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                      <span>ตั้งค่าระบบครั้งแรก (สร้างบัญชี Admin)</span>
                    </div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      สร้าง Username &amp; Password ผู้ดูแลระบบ
                    </h2>
                    <p className="text-sm text-slate-500 leading-relaxed">
                      กำหนดชื่อผู้ใช้และรหัสผ่านสำหรับ Admin คนแรก เพื่อเข้าจัดการทีมและสร้างบัญชีพนักงานคนอื่นๆ
                    </p>
                  </div>

                  {displayError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 space-y-2"
                    >
                      <div>{displayError}</div>
                      {isProviderDisabledError && (
                        <a
                          href={FIREBASE_PROVIDERS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block text-xs font-semibold text-blue-700 underline hover:text-blue-800"
                        >
                          คลิกเพื่อไปเปิด Email/Password ใน Firebase Console →
                        </a>
                      )}
                    </div>
                  )}

                  <form onSubmit={handleBootstrapSetup} className="space-y-4">
                    <div>
                      <label htmlFor="setup-display-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                        ชื่อผู้ดูแลระบบ (แสดงในระบบ) <span className="text-red-600">*</span>
                      </label>
                      <input
                        id="setup-display-name"
                        type="text"
                        required
                        maxLength={120}
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="เช่น ธนวินท์ (Admin)"
                        className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label htmlFor="setup-username" className="block text-xs font-medium text-slate-700 mb-1.5">
                        Username <span className="text-red-600">*</span>
                      </label>
                      <div className="relative">
                        <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="setup-username"
                          type="text"
                          required
                          autoComplete="username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="เช่น admin (a-z, 0-9, ., _, -)"
                          className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="setup-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                        รหัสผ่าน (อย่างน้อย 6 ตัวอักษร) <span className="text-red-600">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="setup-password"
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={6}
                          autoComplete="new-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-10 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-4 py-2.5 text-sm font-medium text-white transition-colors cursor-pointer"
                    >
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                      <span>{submitting ? 'กำลังสร้างบัญชี Admin...' : 'สร้างบัญชี Admin และเข้าสู่ระบบ'}</span>
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-blue-700 text-xs font-semibold">
                      <KeyRound className="w-4 h-4 shrink-0" />
                      <span>เข้าสู่ระบบด้วย Username &amp; Password</span>
                    </div>
                    <h2 className="text-xl font-semibold text-slate-900">เข้าสู่ระบบปฏิบัติงาน</h2>
                    <p className="text-sm text-slate-500 leading-relaxed">
                      กรอกชื่อผู้ใช้ (Username) และรหัสผ่านที่ได้รับจากผู้ดูแลระบบเพื่อเข้าใช้งาน
                    </p>
                  </div>

                  {displayError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 space-y-2"
                    >
                      <div>{displayError}</div>
                      {isProviderDisabledError && (
                        <a
                          href={FIREBASE_PROVIDERS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block text-xs font-semibold text-blue-700 underline hover:text-blue-800"
                        >
                          คลิกเพื่อไปเปิด Email/Password ใน Firebase Console →
                        </a>
                      )}
                    </div>
                  )}

                  <form onSubmit={handlePasswordLogin} className="space-y-4">
                    <div>
                      <label htmlFor="login-username" className="block text-xs font-medium text-slate-700 mb-1.5">
                        ชื่อผู้ใช้ (Username)
                      </label>
                      <div className="relative">
                        <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="login-username"
                          type="text"
                          required
                          autoComplete="username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="เช่น admin หรือ somchai"
                          className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                        รหัสผ่าน (Password)
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="login-password"
                          type={showPassword ? 'text' : 'password'}
                          required
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-10 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 px-4 py-2.5 text-sm font-medium text-white transition-colors cursor-pointer"
                    >
                      <LogIn className="w-4 h-4 shrink-0" />
                      <span>{submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}</span>
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
