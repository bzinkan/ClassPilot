import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Camera, Circle, Square } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface VideoPortalProps {
  studentName: string;
  onClose: () => void;
}

export function VideoPortal({ studentName, onClose }: VideoPortalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const { toast } = useToast();

  // Create portal container on first render
  if (!containerRef.current) {
    const el = document.createElement("div");
    el.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm";
    // Only close when clicking the overlay background, not child elements
    el.onclick = (e) => {
      if (e.target === el) {
        onClose();
      }
    };
    document.body.appendChild(el);
    containerRef.current = el;
  }

  useEffect(() => {
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';
    
    return () => {
      // Restore scroll and cleanup DOM on unmount
      document.body.style.overflow = '';
      
      // Stop recording if active
      if (isRecording) {
        stopRecording();
      }
      
      if (containerRef.current) {
        document.body.removeChild(containerRef.current);
      }
    };
  }, []);

  const handleScreenshot = () => {
    const video = document.querySelector("#portal-video-slot video") as HTMLVideoElement;
    if (!video) {
      toast({
        variant: "destructive",
        title: "Screenshot failed",
        description: "No video found",
      });
      return;
    }

    try {
      // Create canvas to capture frame
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get canvas context');
      }
      
      // Draw current video frame to canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      // Convert to blob and download
      canvas.toBlob((blob) => {
        if (!blob) {
          toast({
            variant: "destructive",
            title: "Screenshot failed",
            description: "Failed to create image",
          });
          return;
        }
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${studentName}_screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toast({
          title: "Screenshot captured",
          description: `Saved screenshot of ${studentName}'s screen`,
        });
      }, 'image/png');
      
    } catch (error) {
      console.error('Screenshot error:', error);
      toast({
        variant: "destructive",
        title: "Screenshot failed",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const startRecording = () => {
    const video = document.querySelector("#portal-video-slot video") as HTMLVideoElement;
    if (!video || !video.srcObject) {
      toast({
        variant: "destructive",
        title: "Recording failed",
        description: "No video stream found",
      });
      return;
    }

    try {
      const stream = video.srcObject as MediaStream;
      
      // Check for supported MIME types
      const mimeTypes = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4',
      ];
      
      let selectedMimeType = '';
      for (const type of mimeTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedMimeType = type;
          break;
        }
      }
      
      if (!selectedMimeType) {
        throw new Error('No supported video recording format found');
      }
      
      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMimeType,
        videoBitsPerSecond: 2500000, // 2.5 Mbps
      });
      
      recordedChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, {
          type: selectedMimeType,
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${studentName}_recording_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toast({
          title: "Recording saved",
          description: `Saved ${formatRecordingDuration(recordingDuration)} recording of ${studentName}'s screen`,
        });
        
        setRecordingDuration(0);
      };
      
      mediaRecorder.start(1000); // Collect data every second
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
      
      // Start duration counter
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
      
      toast({
        title: "Recording started",
        description: `Recording ${studentName}'s screen`,
      });
      
    } catch (error) {
      console.error('Recording error:', error);
      toast({
        variant: "destructive",
        title: "Recording failed",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setIsRecording(false);
      
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
    }
  };

  const formatRecordingDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return createPortal(
    <div
      className="relative w-full max-w-7xl rounded-2xl bg-neutral-900 dark:bg-neutral-950 p-4 shadow-2xl"
      onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
      data-testid="video-portal"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">
            Live View - {studentName}
          </h2>
          {isRecording && (
            <Badge variant="destructive" className="animate-pulse">
              <Circle className="h-2 w-2 mr-1 fill-current" />
              REC {formatRecordingDuration(recordingDuration)}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="text-white hover:bg-white/10"
          data-testid="button-close-portal"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Video Container - video element will be moved here */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
        <div
          id="portal-video-slot"
          className="absolute inset-0 [&>video]:h-full [&>video]:w-full [&>video]:object-contain"
          data-testid="portal-video-slot"
        />
      </div>

      {/* Controls */}
      <div className="mt-3 flex flex-wrap gap-2 justify-center">
        {/* Screenshot */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleScreenshot}
          className="text-white hover:bg-white/10"
          data-testid="button-screenshot"
        >
          <Camera className="h-4 w-4 mr-2" />
          Screenshot
        </Button>

        {/* Recording */}
        <Button
          variant={isRecording ? "destructive" : "ghost"}
          size="sm"
          onClick={isRecording ? stopRecording : startRecording}
          className={isRecording ? "" : "text-white hover:bg-white/10"}
          data-testid="button-record"
        >
          {isRecording ? (
            <>
              <Square className="h-4 w-4 mr-2" />
              Stop Recording
            </>
          ) : (
            <>
              <Circle className="h-4 w-4 mr-2" />
              Record
            </>
          )}
        </Button>

        {/* Back to Grid */}
        <Button
          variant="default"
          size="sm"
          onClick={onClose}
          data-testid="button-back-to-grid"
        >
          Back to Grid
        </Button>
      </div>
    </div>,
    containerRef.current
  );
}
