import { useState, useRef, useEffect, useCallback } from "react";
import { Eye, EyeOff, Timer, Clock, BarChart3, Hand, MessageSquare, X, Send, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const FAB_POSITION_KEY = "classpilot-fab-position";

interface RaisedHand {
  studentId: string;
  studentName: string;
  studentEmail: string;
  timestamp: string;
}

interface StudentMessage {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  message: string;
  messageType: string;
  timestamp: string;
  read: boolean;
}

interface TeacherFabProps {
  // Attention mode
  attentionActive: boolean;
  onAttentionClick: () => void;
  attentionPending?: boolean;

  // Timer
  timerActive: boolean;
  onTimerClick: () => void;
  timerPending?: boolean;

  // Poll
  activePoll: { id: string; question: string; options: string[] } | null;
  pollTotalResponses: number;
  onPollClick: () => void;
  pollPending?: boolean;

  // Raised hands
  raisedHands: Map<string, RaisedHand>;
  onDismissHand: (studentId: string) => void;
  handRaisingEnabled?: boolean;
  onToggleHandRaising?: (enabled: boolean) => void;

  // Messages
  studentMessages: StudentMessage[];
  onMarkMessageRead: (messageId: string) => void;
  onDismissMessage: (messageId: string) => void;
  onReplyToMessage: (studentId: string, message: string) => void;
  replyPending?: boolean;
  studentMessagingEnabled?: boolean;
  onToggleStudentMessaging?: (enabled: boolean) => void;
}

export function TeacherFab({
  attentionActive,
  onAttentionClick,
  attentionPending,
  timerActive,
  onTimerClick,
  timerPending,
  activePoll,
  pollTotalResponses,
  onPollClick,
  pollPending,
  raisedHands,
  onDismissHand,
  handRaisingEnabled = true,
  onToggleHandRaising,
  studentMessages,
  onMarkMessageRead,
  onDismissMessage,
  onReplyToMessage,
  replyPending,
  studentMessagingEnabled = true,
  onToggleStudentMessaging,
}: TeacherFabProps) {
  const [expanded, setExpanded] = useState(false);
  const [activePanel, setActivePanel] = useState<'hands' | 'messages' | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  // Draggable FAB state
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 24, y: 24 }); // bottom-right offset
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);
  const fabRef = useRef<HTMLDivElement>(null);
  const hasDraggedRef = useRef(false);

  // Load saved position from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(FAB_POSITION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          setPosition(parsed);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save position to localStorage when it changes
  const savePosition = useCallback((pos: { x: number; y: number }) => {
    try {
      localStorage.setItem(FAB_POSITION_KEY, JSON.stringify(pos));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Handle drag start (mouse)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y,
    };
    setIsDragging(true);
  }, [position]);

  // Handle drag start (touch)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      posX: position.x,
      posY: position.y,
    };
    setIsDragging(true);
  }, [position]);

  // Handle drag move and end
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const deltaX = dragStartRef.current.x - e.clientX;
      const deltaY = dragStartRef.current.y - e.clientY;

      // Only count as drag if moved more than 5px
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasDraggedRef.current = true;
      }

      const newX = Math.max(10, Math.min(window.innerWidth - 70, dragStartRef.current.posX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 70, dragStartRef.current.posY + deltaY));
      setPosition({ x: newX, y: newY });
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!dragStartRef.current || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const deltaX = dragStartRef.current.x - touch.clientX;
      const deltaY = dragStartRef.current.y - touch.clientY;

      // Only count as drag if moved more than 5px
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasDraggedRef.current = true;
      }

      const newX = Math.max(10, Math.min(window.innerWidth - 70, dragStartRef.current.posX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 70, dragStartRef.current.posY + deltaY));
      setPosition({ x: newX, y: newY });
    };

    const handleEnd = () => {
      if (dragStartRef.current) {
        savePosition(position);
      }
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, position, savePosition]);

  // Handle FAB click - only toggle if not dragging
  const handleFabClick = useCallback(() => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return; // Don't toggle if we just finished dragging
    }
    setExpanded(!expanded);
    if (expanded) setActivePanel(null);
  }, [expanded]);

  const unreadCount = studentMessages.filter(m => !m.read).length;
  const handsCount = raisedHands.size;
  const totalNotifications = unreadCount + handsCount;

  const handleReply = (studentId: string) => {
    if (replyText.trim()) {
      onReplyToMessage(studentId, replyText.trim());
      setReplyText("");
      setReplyingTo(null);
    }
  };

  return (
    <div
      ref={fabRef}
      className="fixed z-50 flex flex-col items-end gap-3"
      style={{
        right: `${position.x}px`,
        bottom: `${position.y}px`,
      }}
    >
      {/* Hands Panel */}
      {activePanel === 'hands' && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-80 max-h-96 overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 flex items-center justify-between">
            <span className="text-white font-semibold flex items-center gap-2">
              <Hand className="h-4 w-4" />
              Raised Hands ({handsCount})
            </span>
            <div className="flex items-center gap-2">
              {onToggleHandRaising && (
                <button
                  onClick={() => onToggleHandRaising(!handRaisingEnabled)}
                  className={cn(
                    "text-xs px-2 py-1 rounded font-medium transition-colors",
                    handRaisingEnabled
                      ? "bg-white/20 text-white hover:bg-white/30"
                      : "bg-red-600 text-white hover:bg-red-700"
                  )}
                  title={handRaisingEnabled ? "Click to disable hand raising" : "Click to enable hand raising"}
                >
                  {handRaisingEnabled ? "ON" : "OFF"}
                </button>
              )}
              <button
                onClick={() => setActivePanel(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {handsCount === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                No raised hands
              </div>
            ) : (
              Array.from(raisedHands.values()).map((hand) => (
                <div
                  key={hand.studentId}
                  className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 last:border-b-0 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                      <Hand className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">{hand.studentName}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {new Date(hand.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => onDismissHand(hand.studentId)}
                    className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Messages Panel */}
      {activePanel === 'messages' && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-80 max-h-96 overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
          <div className="bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-3 flex items-center justify-between">
            <span className="text-white font-semibold flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Messages ({unreadCount} new)
            </span>
            <div className="flex items-center gap-2">
              {onToggleStudentMessaging && (
                <button
                  onClick={() => onToggleStudentMessaging(!studentMessagingEnabled)}
                  className={cn(
                    "text-xs px-2 py-1 rounded font-medium transition-colors",
                    studentMessagingEnabled
                      ? "bg-white/20 text-white hover:bg-white/30"
                      : "bg-red-600 text-white hover:bg-red-700"
                  )}
                  title={studentMessagingEnabled ? "Click to disable student messaging" : "Click to enable student messaging"}
                >
                  {studentMessagingEnabled ? "ON" : "OFF"}
                </button>
              )}
              <button
                onClick={() => setActivePanel(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {studentMessages.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                No messages from students
              </div>
            ) : (
              studentMessages.slice(0, 10).map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "px-4 py-3 border-b border-gray-100 dark:border-gray-700 last:border-b-0 transition-colors",
                    !msg.read && "bg-blue-50 dark:bg-blue-950/30"
                  )}
                  onClick={() => onMarkMessageRead(msg.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "text-xs px-1.5 py-0.5 rounded font-medium",
                          msg.messageType === 'question'
                            ? "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300"
                            : "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300"
                        )}>
                          {msg.messageType === 'question' ? '?' : 'msg'}
                        </span>
                        <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                          {msg.studentName}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 break-words">
                        {msg.message}
                      </p>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setReplyingTo(replyingTo === msg.id ? null : msg.id);
                          setReplyText("");
                        }}
                        className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        title="Reply"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDismissMessage(msg.id);
                        }}
                        className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        title="Dismiss"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {replyingTo === msg.id && (
                    <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <Input
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Type reply..."
                        className="h-8 text-sm"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && replyText.trim()) {
                            handleReply(msg.studentId);
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        className="h-8 px-3"
                        disabled={!replyText.trim() || replyPending}
                        onClick={() => handleReply(msg.studentId)}
                      >
                        <Send className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* FAB Menu Items */}
      {expanded && (
        <div className="flex flex-col gap-2 animate-in slide-in-from-bottom-2 duration-200">
          {/* Messages */}
          <button
            onClick={() => setActivePanel(activePanel === 'messages' ? null : 'messages')}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              activePanel === 'messages' || unreadCount > 0
                ? "bg-blue-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            <MessageSquare className="h-5 w-5" />
            <span className="font-medium">Messages</span>
            {unreadCount > 0 && (
              <span className="bg-white text-blue-600 text-xs font-bold px-2 py-0.5 rounded-full">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Raised Hands */}
          <button
            onClick={() => setActivePanel(activePanel === 'hands' ? null : 'hands')}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              activePanel === 'hands' || handsCount > 0
                ? "bg-amber-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700",
              handsCount > 0 && activePanel !== 'hands' && "animate-pulse"
            )}
          >
            <Hand className="h-5 w-5" />
            <span className="font-medium">Hands</span>
            {handsCount > 0 && (
              <span className="bg-white text-amber-600 text-xs font-bold px-2 py-0.5 rounded-full">
                {handsCount}
              </span>
            )}
          </button>

          {/* Poll */}
          <button
            onClick={() => {
              onPollClick();
              setExpanded(false);
              setActivePanel(null);
            }}
            disabled={pollPending}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              activePoll
                ? "bg-violet-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            <BarChart3 className="h-5 w-5" />
            <span className="font-medium">{activePoll ? `Poll (${pollTotalResponses})` : "Poll"}</span>
          </button>

          {/* Timer */}
          <button
            onClick={() => {
              onTimerClick();
              setExpanded(false);
              setActivePanel(null);
            }}
            disabled={timerPending}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              timerActive
                ? "bg-teal-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            {timerActive ? <Clock className="h-5 w-5" /> : <Timer className="h-5 w-5" />}
            <span className="font-medium">{timerActive ? "Stop Timer" : "Timer"}</span>
          </button>

          {/* Attention */}
          <button
            onClick={() => {
              onAttentionClick();
              setExpanded(false);
              setActivePanel(null);
            }}
            disabled={attentionPending}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-200 hover:scale-105",
              attentionActive
                ? "bg-indigo-500 text-white"
                : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700"
            )}
          >
            {attentionActive ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            <span className="font-medium">{attentionActive ? "Release" : "Attention"}</span>
          </button>
        </div>
      )}

      {/* Main FAB Button */}
      <button
        onClick={handleFabClick}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className={cn(
          "w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 relative select-none",
          expanded
            ? "bg-gray-600 dark:bg-gray-700 rotate-45"
            : "bg-gradient-to-br from-blue-500 to-indigo-600",
          isDragging ? "cursor-grabbing scale-110" : "cursor-grab hover:scale-110"
        )}
      >
        {expanded ? (
          <X className="h-6 w-6 text-white -rotate-45" />
        ) : (
          <GraduationCap className="h-6 w-6 text-white" />
        )}

        {/* Notification Badge */}
        {!expanded && totalNotifications > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center animate-pulse">
            {totalNotifications > 9 ? '9+' : totalNotifications}
          </span>
        )}
      </button>
    </div>
  );
}
