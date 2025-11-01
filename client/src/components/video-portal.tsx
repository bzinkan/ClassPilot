import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Maximize, Minimize, X } from "lucide-react";

interface VideoPortalProps {
  studentName: string;
  onClose: () => void;
}

export function VideoPortal({ studentName, onClose }: VideoPortalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Create portal container on first render
  if (!containerRef.current) {
    const el = document.createElement("div");
    el.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm";
    el.onclick = onClose; // Click outside to close
    document.body.appendChild(el);
    containerRef.current = el;
  }

  useEffect(() => {
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';
    
    return () => {
      // Restore scroll and cleanup DOM on unmount
      document.body.style.overflow = '';
      if (containerRef.current) {
        document.body.removeChild(containerRef.current);
      }
    };
  }, []);

  const handleFullscreen = async () => {
    const videoSlot = document.querySelector("#portal-video-slot");
    if (!videoSlot) return;
    
    try {
      if (!document.fullscreenElement) {
        await videoSlot.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen error:', error);
    }
  };

  const handlePictureInPicture = async () => {
    const video = document.querySelector("#portal-video-slot video") as HTMLVideoElement;
    if (!video) return;
    
    try {
      // @ts-ignore - PiP API not fully typed
      if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
        // @ts-ignore
        await video.requestPictureInPicture();
      } else if (document.pictureInPictureElement) {
        // @ts-ignore
        await document.exitPictureInPicture();
      }
    } catch (error) {
      console.error('Picture-in-Picture error:', error);
    }
  };

  return createPortal(
    <div
      className="relative w-full max-w-7xl rounded-2xl bg-neutral-900 dark:bg-neutral-950 p-4 shadow-2xl"
      onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
      data-testid="video-portal"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white">
          Live View - {studentName}
        </h2>
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
      <div className="mt-3 flex gap-2 justify-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleFullscreen}
          className="text-white hover:bg-white/10"
          data-testid="button-fullscreen"
        >
          <Maximize className="h-4 w-4 mr-2" />
          Fullscreen
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePictureInPicture}
          className="text-white hover:bg-white/10"
          data-testid="button-pip"
        >
          <Minimize className="h-4 w-4 mr-2" />
          Picture-in-Picture
        </Button>
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
