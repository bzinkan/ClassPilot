import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Monitor, ExternalLink, AlertTriangle } from "lucide-react";
import type { StudentStatus } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";

interface StudentTileProps {
  student: StudentStatus;
  onClick: () => void;
  blockedDomains?: string[];
}

function isBlockedDomain(url: string | null, blockedDomains: string[]): boolean {
  if (!url || blockedDomains.length === 0) return false;
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    return blockedDomains.some(blocked => {
      const blockedLower = blocked.toLowerCase().trim();
      // Check exact match or subdomain match
      return hostname === blockedLower || hostname.endsWith('.' + blockedLower);
    });
  } catch {
    return false;
  }
}

export function StudentTile({ student, onClick, blockedDomains = [] }: StudentTileProps) {
  const isBlocked = isBlockedDomain(student.activeTabUrl, blockedDomains);
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-status-online';
      case 'idle':
        return 'bg-status-away';
      case 'offline':
        return 'bg-status-offline';
      default:
        return 'bg-status-offline';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'idle':
        return 'Idle';
      case 'offline':
        return 'Offline';
      default:
        return 'Unknown';
    }
  };

  const getBorderStyle = (status: string) => {
    if (isBlocked) {
      return 'border-2 border-destructive';
    }
    
    switch (status) {
      case 'online':
        return 'border-2 border-status-online/30';
      case 'idle':
        return 'border-2 border-dashed border-status-away/40';
      case 'offline':
        return 'border border-border/60';
      default:
        return 'border border-border';
    }
  };

  const getOpacity = (status: string) => {
    switch (status) {
      case 'online':
        return 'opacity-100';
      case 'idle':
        return 'opacity-80';
      case 'offline':
        return 'opacity-60';
      default:
        return 'opacity-60';
    }
  };

  return (
    <Card
      data-testid={`card-student-${student.deviceId}`}
      className={`${getBorderStyle(student.status)} ${getOpacity(student.status)} hover-elevate cursor-pointer transition-all duration-200 overflow-visible`}
      onClick={onClick}
    >
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-base truncate" data-testid={`text-student-name-${student.deviceId}`}>
              {student.studentName}
            </h3>
            <p className="text-xs font-mono text-muted-foreground truncate">
              {student.deviceId}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isBlocked && (
              <Badge variant="destructive" className="text-xs px-2 py-0.5" data-testid={`badge-blocked-${student.deviceId}`}>
                <AlertTriangle className="h-3 w-3 mr-1" />
                Blocked
              </Badge>
            )}
            {student.isSharing && (
              <Badge variant="destructive" className="text-xs px-2 py-0.5 animate-pulse">
                Sharing
              </Badge>
            )}
            <div
              className={`h-3 w-3 rounded-full flex-shrink-0 ${getStatusColor(student.status)} ${
                student.status === 'online' ? 'animate-pulse' : ''
              }`}
              title={getStatusLabel(student.status)}
            />
          </div>
        </div>

        {/* Active Tab Info */}
        <div className="space-y-2 mb-3">
          <div className="flex items-start gap-2">
            {student.favicon && (
              <img
                src={student.favicon}
                alt=""
                className="w-4 h-4 flex-shrink-0 mt-0.5"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <p className="text-sm flex-1 line-clamp-2" data-testid={`text-tab-title-${student.deviceId}`}>
              {student.activeTabTitle || "No active tab"}
            </p>
          </div>
          {student.activeTabUrl && (
            <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
              <ExternalLink className="h-3 w-3 flex-shrink-0" />
              <span className="truncate" data-testid={`text-tab-url-${student.deviceId}`}>
                {student.activeTabUrl}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-3 border-t border-border/50">
          <Clock className="h-3 w-3" />
          <span data-testid={`text-last-seen-${student.deviceId}`}>
            {formatDistanceToNow(student.lastSeenAt, { addSuffix: true })}
          </span>
        </div>
      </div>
    </Card>
  );
}
