import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign,
  Bell,
  CheckCheck,
  ExternalLink,
  MessageSquareText,
  Paperclip,
  Trash2,
} from 'lucide-react';
import { resolveCaseLinkDisplay } from '../lib/caseLink.ts';
import { formatThaiDateTime } from '../lib/sla.ts';
import type { NoteNotification, RoleLevel } from '../types.ts';

interface NoteNotificationBellProps {
  notifications: NoteNotification[];
  onSelectNotification: (notification: NoteNotification) => Promise<'opened' | 'unavailable'>;
  onMarkAllRead: () => Promise<void>;
  onClearRead: () => Promise<void>;
}

function getShortRoleLabel(role: RoleLevel): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'tl':
      return 'TL';
    case 'agent':
      return 'Agent';
  }
}

export const NoteNotificationBell: React.FC<NoteNotificationBellProps> = ({
  notifications,
  onSelectNotification,
  onMarkAllRead,
  onClearRead,
}) => {
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<'mark_all' | 'clear_read' | null>(null);
  const [unavailableNotice, setUnavailableNotice] = useState<{
    caseLabel: string;
    caseUrl: string | null;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.is_read).length,
    [notifications]
  );
  const readCount = notifications.length - unreadCount;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    setOpen((prev) => {
      if (!prev) {
        setUnavailableNotice(null);
      }
      return !prev;
    });
  };

  const handleItemClick = async (item: NoteNotification) => {
    setUnavailableNotice(null);
    const result = await onSelectNotification(item);
    if (result === 'opened') {
      setOpen(false);
    } else {
      const linkDisplay = resolveCaseLinkDisplay(item.case_no, item.case_url);
      setUnavailableNotice({
        caseLabel: linkDisplay.label || item.case_no,
        caseUrl: linkDisplay.url,
      });
    }
  };

  const handleMarkAll = async () => {
    if (busyAction || unreadCount === 0) return;
    setBusyAction('mark_all');
    try {
      await onMarkAllRead();
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearRead = async () => {
    if (busyAction || readCount === 0) return;
    setBusyAction('clear_read');
    try {
      await onClearRead();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          unreadCount > 0
            ? `การแจ้งเตือน Internal Note ใหม่ ${unreadCount} รายการ`
            : 'การแจ้งเตือน Internal Note'
        }
        title="การแจ้งเตือน Internal Note"
        className={`relative inline-flex items-center justify-center w-9 h-9 rounded-lg border transition-colors cursor-pointer ${
          open
            ? 'border-blue-300 bg-blue-50 text-blue-700'
            : unreadCount > 0
              ? 'border-blue-200 bg-blue-50/70 hover:bg-blue-100/80 text-blue-700'
              : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-600'
        }`}
      >
        <Bell className="w-4 h-4 shrink-0" />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold leading-none inline-flex items-center justify-center tabular-nums ring-2 ring-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="รายการแจ้งเตือน Internal Note"
          className="fixed sm:absolute left-3 right-3 sm:left-auto sm:right-0 top-[4.25rem] sm:top-full sm:mt-2 sm:w-[400px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-200 bg-white shadow-xl z-40 overflow-hidden"
        >
          {/* Popover Header */}
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <MessageSquareText className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-sm font-semibold text-slate-900 truncate">
                แจ้งเตือน Internal Note
              </span>
              {unreadCount > 0 && (
                <span className="inline-flex items-center rounded-md bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-800 tabular-nums shrink-0">
                  ใหม่ {unreadCount}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  disabled={busyAction !== null}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100/70 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <CheckCheck className="w-3.5 h-3.5 shrink-0" />
                  <span>อ่านทั้งหมด</span>
                </button>
              )}
              {readCount > 0 && (
                <button
                  type="button"
                  onClick={handleClearRead}
                  disabled={busyAction !== null}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200/70 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>ล้างที่อ่าน</span>
                </button>
              )}
            </div>
          </div>

          {unavailableNotice && (
            <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 space-y-1">
              <div className="font-medium">
                ไม่พบเคส {unavailableNotice.caseLabel} ในรายการที่คุณเข้าถึงได้ในขณะนี้ (อาจถูกส่งต่อไปทีมอื่นหรือถูกลบแล้ว)
              </div>
              {unavailableNotice.caseUrl && (
                <a
                  href={unavailableNotice.caseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                >
                  <span>เปิดลิงก์เคสภายนอก</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {/* Notification List */}
          <div className="max-h-[400px] overflow-y-auto divide-y divide-slate-100">
            {notifications.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 mx-auto flex items-center justify-center mb-2.5">
                  <Bell className="w-5 h-5" />
                </div>
                <p className="text-sm font-medium text-slate-700">
                  ยังไม่มีการแจ้งเตือน Internal Note
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  เมื่อมี Internal Note ใหม่หรือถูก @แท็ก ในเคส ระบบจะแจ้งเตือนที่นี่ทันที
                </p>
              </div>
            ) : (
              notifications.map((item) => {
                const linkDisplay = resolveCaseLinkDisplay(item.case_no, item.case_url);
                const caseLabel = linkDisplay.label || item.case_no;
                const isMention = item.notification_type === 'mention';
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void handleItemClick(item)}
                    className={`w-full text-left px-4 py-3 transition-colors flex items-start gap-3 cursor-pointer ${
                      item.is_read
                        ? 'bg-white hover:bg-slate-50'
                        : isMention
                          ? 'bg-indigo-50/60 hover:bg-indigo-50'
                          : 'bg-blue-50/55 hover:bg-blue-50'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                        item.is_read
                          ? 'bg-slate-200'
                          : isMention
                            ? 'bg-indigo-600'
                            : 'bg-blue-600'
                      }`}
                    />

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="text-xs font-semibold text-slate-900 truncate">
                            {item.author_name}
                          </span>
                          <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 shrink-0">
                            {getShortRoleLabel(item.author_role)}
                          </span>
                          {isMention && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-800 shrink-0">
                              <AtSign className="w-2.5 h-2.5 shrink-0" />
                              <span>
                                {item.mentioned_team_name
                                  ? `แท็กทีม ${item.mentioned_team_name}`
                                  : 'แท็กคุณ'}
                              </span>
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-400 whitespace-nowrap shrink-0">
                          {formatThaiDateTime(item.created_at)}
                        </span>
                      </div>

                      <div className="text-xs font-medium text-blue-800 truncate">
                        เคส {caseLabel}
                        {item.issue_summary ? (
                          <span className="text-slate-600 font-normal"> · {item.issue_summary}</span>
                        ) : null}
                      </div>

                      {item.note_preview && (
                        <p className="text-xs text-slate-700 line-clamp-2 break-words">
                          {item.note_preview}
                        </p>
                      )}

                      {item.attachment_count > 0 && (
                        <div className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
                          <Paperclip className="w-3 h-3 shrink-0" />
                          <span>แนบไฟล์ {item.attachment_count} รายการ</span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
