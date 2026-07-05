/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { UploadCloud, Download, Image as ImageIcon, CheckCircle2, RefreshCw, X, Grid3X3, Layers, Scissors, Trash2, RotateCcw, RotateCw, ZoomIn, ZoomOut, FlipHorizontal, FlipVertical, Sparkles, Wand2, Maximize2, Archive, Library, Plus, ArrowUp, ArrowDown, Move } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { removeBackgroundV2 } from './lib/bgRemoval';

type ToolType = 'splitter' | 'bg-remover' | 'ai-expand' | 'stitcher';

type StitchFile = {
  id: string;
  file: File;
  previewUrl: string;
  width: number;
  height: number;
  rotation: number; // 0, 90, 180, 270
  flipH: boolean;
  flipV: boolean;
  name: string;
  scale?: number;
  customWidth?: number;
  customHeight?: number;
  offsetX?: number;
  offsetY?: number;
};

const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
};

const drawImageWithTransform = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  rotation: number,
  flipH: boolean,
  flipV: boolean
) => {
  ctx.save();
  ctx.translate(dx + dw / 2, dy + dh / 2);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.rotate((rotation * Math.PI) / 180);
  
  const is90or270 = rotation === 90 || rotation === 270;
  const drawW = is90or270 ? dh : dw;
  const drawH = is90or270 ? dw : dh;
  
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
};

type BgFile = {
  id: string;
  file: File;
  previewUrl: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  resultBlob?: Blob;
  resultUrl?: string;
  errorMsg?: string;
};

type PieceTransform = {
  rotation: number; 
  flipH: boolean;
  flipV: boolean;
};

interface LibraryItem {
  id: string;
  blob: Blob;
  name: string;
  previewUrl: string;
}

const getIntersection = (
  vLine: { pos: number, angle: number } | 'left' | 'right',
  hLine: { pos: number, angle: number } | 'top' | 'bottom',
  W: number,
  H: number,
  centerY: number
) => {
  if (vLine === 'left' && hLine === 'top') return { x: 0, y: 0 };
  if (vLine === 'left' && hLine === 'bottom') return { x: 0, y: H };
  if (vLine === 'right' && hLine === 'top') return { x: W, y: 0 };
  if (vLine === 'right' && hLine === 'bottom') return { x: W, y: H };

  if (vLine === 'left') {
    const cy = hLine === 'top' ? 0 : hLine === 'bottom' ? H : (hLine as any).pos * H;
    const hRad = hLine === 'top' || hLine === 'bottom' ? 0 : (hLine as any).angle * Math.PI / 180;
    const y = cy + (0 - W / 2) * Math.tan(hRad);
    return { x: 0, y: Math.max(0, Math.min(H, y)) };
  }

  if (vLine === 'right') {
    const cy = hLine === 'top' ? 0 : hLine === 'bottom' ? H : (hLine as any).pos * H;
    const hRad = hLine === 'top' || hLine === 'bottom' ? 0 : (hLine as any).angle * Math.PI / 180;
    const y = cy + (W - W / 2) * Math.tan(hRad);
    return { x: W, y: Math.max(0, Math.min(H, y)) };
  }

  if (hLine === 'top') {
    const cx = (vLine as any) === 'left' ? 0 : (vLine as any) === 'right' ? W : (vLine as any).pos * W;
    const vRad = (vLine as any) === 'left' || (vLine as any) === 'right' ? 0 : (vLine as any).angle * Math.PI / 180;
    const x = cx - (0 - centerY) * Math.tan(vRad);
    return { x: Math.max(0, Math.min(W, x)), y: 0 };
  }

  if (hLine === 'bottom') {
    const cx = (vLine as any) === 'left' ? 0 : (vLine as any) === 'right' ? W : (vLine as any).pos * W;
    const vRad = (vLine as any) === 'left' || (vLine as any) === 'right' ? 0 : (vLine as any).angle * Math.PI / 180;
    const x = cx - (H - centerY) * Math.tan(vRad);
    return { x: Math.max(0, Math.min(W, x)), y: H };
  }

  const cx = vLine.pos * W;
  const vRad = vLine.angle * Math.PI / 180;
  const cy = hLine.pos * H;
  const hRad = hLine.angle * Math.PI / 180;

  const tanV = Math.tan(vRad);
  const tanH = Math.tan(hRad);
  const denom = 1 + tanV * tanH;

  let x = (cx - (cy - centerY) * tanV + (W / 2) * tanV * tanH) / denom;
  let y = cy + (x - W / 2) * tanH;

  x = Math.max(0, Math.min(W, x));
  y = Math.max(0, Math.min(H, y));

  return { x, y };
};

export default function App() {
  const [currentTool, setCurrentTool] = useState<ToolType>('splitter');
  
  // -- Library State --
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [showLibrary, setShowLibrary] = useState<boolean>(false);
  
  // -- Splitter State --
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [downloadBaseName, setDownloadBaseName] = useState<string>('');
  
  // -- Transform State --
  const [originalSize, setOriginalSize] = useState<{width: number, height: number} | null>(null);
  const [resizeWidth, setResizeWidth] = useState<string>("");
  const [resizeHeight, setResizeHeight] = useState<string>("");
  const [rotation, setRotation] = useState<number>(0);
  const [maintainAspect, setMaintainAspect] = useState<boolean>(true);
  const [isApplyingTransform, setIsApplyingTransform] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [pieceTransforms, setPieceTransforms] = useState<Record<number, PieceTransform>>({});
  const [pieceNames, setPieceNames] = useState<Record<number, string>>({});
  const [selectedPieces, setSelectedPieces] = useState<Set<number>>(new Set());
  const [isUpscaling, setIsUpscaling] = useState<boolean>(false);
  const [isSharpening, setIsSharpening] = useState<boolean>(false);
  const [isExpandingAI, setIsExpandingAI] = useState<boolean>(false);
  const [expandWidth, setExpandWidth] = useState<string>("1920");
  const [expandHeight, setExpandHeight] = useState<string>("1080");
  const [expandPrompt, setExpandPrompt] = useState<string>("Professional high-quality outpainting, extend the background seamlessly to match the original style and content.");
  const [expandOffsets, setExpandOffsets] = useState<{top: number, bottom: number, left: number, right: number}>({top: 0, bottom: 0, left: 0, right: 0});
  useEffect(() => {
    if (imageSize) {
      setExpandWidth((imageSize.width + expandOffsets.left + expandOffsets.right).toString());
      setExpandHeight((imageSize.height + expandOffsets.top + expandOffsets.bottom).toString());
    }
  }, [imageSize, expandOffsets]);
  
  const [columnsStr, setColumnsStr] = useState<string>("4");
  const [rowsStr, setRowsStr] = useState<string>("3");
  const [vLinesPerRow, setVLinesPerRow] = useState<{pos: number, angle: number}[][]>([
    [{pos: 0.25, angle: 0}, {pos: 0.5, angle: 0}, {pos: 0.75, angle: 0}],
    [{pos: 0.25, angle: 0}, {pos: 0.5, angle: 0}, {pos: 0.75, angle: 0}],
    [{pos: 0.25, angle: 0}, {pos: 0.5, angle: 0}, {pos: 0.75, angle: 0}]
  ]);
  const [hLines, setHLines] = useState<{ pos: number; angle: number }[]>([
    { pos: 1/3, angle: 0 },
    { pos: 2/3, angle: 0 }
  ]);
  const [selectedLine, setSelectedLine] = useState<
    | { type: 'v'; rIdx: number; cIdx: number }
    | { type: 'h'; idx: number }
    | null
  >(null);

  const getTotalSlices = () => {
    let total = 0;
    for (let i = 0; i < hLines.length + 1; i++) {
        total += (vLinesPerRow[i]?.length || 0) + 1;
    }
    return total;
  };
  const totalSlices = getTotalSlices();

  const [isDetectingGrid, setIsDetectingGrid] = useState<boolean>(false);
  const [previewMode, setPreviewMode] = useState<'grid' | 'exploded'>('grid');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);

  // -- BG Remover State --
  const [bgFiles, setBgFiles] = useState<BgFile[]>([]);
  const [bgSensitivity, setBgSensitivity] = useState<number>(0);
  const [keepPrompt, setKeepPrompt] = useState<string>('');
  const [removePrompt, setRemovePrompt] = useState<string>('');
  const [isRemovingBg, setIsRemovingBg] = useState<boolean>(false);

  // -- Settings --
  const [downloadAsZip, setDownloadAsZip] = useState<boolean>(false);

  // -- Refs --
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgFileInputRef = useRef<HTMLInputElement>(null);
  const imageElementRef = useRef<HTMLImageElement>(null);
  const stitchFileInputRef = useRef<HTMLInputElement>(null);

  // -- Stitcher State --
  const [stitchFiles, setStitchFiles] = useState<StitchFile[]>([]);
  const [stitchLayout, setStitchLayout] = useState<'horizontal' | 'vertical' | 'grid'>('vertical');
  const [stitchGridMode, setStitchGridMode] = useState<'columns' | 'rows'>('rows');
  const [stitchColumns, setStitchColumns] = useState<number>(2);
  const [stitchRows, setStitchRows] = useState<number>(4);
  const [stitchGap, setStitchGap] = useState<number>(10);
  const [stitchPadding, setStitchPadding] = useState<number>(10);
  const [stitchBgColor, setStitchBgColor] = useState<string>('#0f172a');
  const [stitchAlignment, setStitchAlignment] = useState<'start' | 'center' | 'end'>('center');
  const [stitchResizeMode, setStitchResizeMode] = useState<'original' | 'match-max' | 'match-min'>('match-max');
  const [stitchPreviewUrl, setStitchPreviewUrl] = useState<string | null>(null);
  const [stitchWorkspaceView, setStitchWorkspaceView] = useState<'preview' | 'interactive'>('interactive');
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [resizeStart, setResizeStart] = useState<{ x: number; y: number; scale: number } | null>(null);

  const [stitchMouseMode, setStitchMouseMode] = useState<'reorder' | 'offset'>('offset');
  const [draggingOffsetId, setDraggingOffsetId] = useState<string | null>(null);
  const [offsetDragStart, setOffsetDragStart] = useState<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (!resizingId || !resizeStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStart.x;
      // 140px of drag corresponds to a scale factor of 1.0
      const deltaScale = dx / 140;
      const newScale = Math.max(0.1, Math.min(5.0, resizeStart.scale + deltaScale));

      setStitchFiles(prev => prev.map(f => {
        if (f.id === resizingId) {
          return {
            ...f,
            scale: parseFloat(newScale.toFixed(2))
          };
        }
        return f;
      }));
    };

    const handleMouseUp = () => {
      setResizingId(null);
      setResizeStart(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingId, resizeStart]);

  useEffect(() => {
    if (!draggingOffsetId || !offsetDragStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - offsetDragStart.x;
      const dy = e.clientY - offsetDragStart.y;

      setStitchFiles(prev => prev.map(f => {
        if (f.id === draggingOffsetId) {
          return {
            ...f,
            offsetX: Math.round(offsetDragStart.ox + dx),
            offsetY: Math.round(offsetDragStart.oy + dy)
          };
        }
        return f;
      }));
    };

    const handleMouseUp = () => {
      setDraggingOffsetId(null);
      setOffsetDragStart(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingOffsetId, offsetDragStart]);

  // --- Splitter Logic ---
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageSize({
      width: e.currentTarget.naturalWidth,
      height: e.currentTarget.naturalHeight,
    });
  };

  const processFile = (file: File) => {
    setError(null);
    setPreviewMode('grid');
    if (!file.type.startsWith('image/')) {
      setError('Please select a valid image file (JPEG, PNG, WebP).');
      return;
    }
    setImageFile(file);
    setDownloadBaseName(file.name.substring(0, file.name.lastIndexOf('.')) || 'image');
    const url = URL.createObjectURL(file);
    setOriginalImageUrl(url);
    setImagePreviewUrl(url);
    setRotation(0);
    
    const img = new Image();
    img.onload = () => {
      setOriginalSize({ width: img.width, height: img.height });
      setImageSize({ width: img.width, height: img.height });
      setResizeWidth(img.width.toString());
      setResizeHeight(img.height.toString());
    };
    img.src = url;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Don't paste if user is typing in an input or textarea
      if (['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement)?.tagName)) {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;
      
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            processFile(blob);
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const applyTransform = async () => {
    if (!originalImageUrl) return;
    setIsApplyingTransform(true);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = originalImageUrl;
      });
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("No 2d context");
      
      const rad = rotation * Math.PI / 180;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      
      const rWidth = parseInt(resizeWidth) || img.width;
      const rHeight = parseInt(resizeHeight) || img.height;
      
      const newWidth = Math.round(rWidth * absCos + rHeight * absSin);
      const newHeight = Math.round(rWidth * absSin + rHeight * absCos);
      
      canvas.width = newWidth;
      canvas.height = newHeight;
      
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      ctx.translate(newWidth / 2, newHeight / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -Math.round(rWidth / 2), -Math.round(rHeight / 2), rWidth, rHeight);
      
      canvas.toBlob((blob) => {
        if (blob) {
           if (imagePreviewUrl && imagePreviewUrl !== originalImageUrl) {
              URL.revokeObjectURL(imagePreviewUrl);
           }
           const newUrl = URL.createObjectURL(blob);
           setImagePreviewUrl(newUrl);
        }
        setIsApplyingTransform(false);
      }, imageFile?.type || 'image/png', 1.0);
    } catch (err) {
      console.error(err);
      setIsApplyingTransform(false);
    }
  };

  const updateGridLines = (cStr: string, rStr: string) => {
    let c = Math.round(parseFloat(cStr));
    let r = Math.round(parseFloat(rStr));
    
    if (isNaN(c) || c < 1) c = 1;
    if (isNaN(r) || r < 1) r = 1;
    
    let h: {pos: number, angle: number}[] = [];
    if (r > 0) {
      let step = 1 / r;
      for (let i = step; i < 0.9999; i += step) h.push({pos: i, angle: 0});
      setHLines(h);
    }
    
    if (c > 0) {
      let v: {pos: number, angle: number}[] = [];
      let step = 1 / c;
      for (let i = step; i < 0.9999; i += step) v.push({pos: i, angle: 0});
      setVLinesPerRow(Array.from({ length: h.length + 1 }, () => v.map(l => ({...l}))));
    } else {
      setVLinesPerRow(Array.from({ length: h.length + 1 }, () => []));
    }
    setPieceTransforms({});
    setPieceNames({});
  };

  const handleReset = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(null);
    setImageFile(null);
    setDownloadBaseName('');
    setImageSize(null);
    setError(null);
    setColumnsStr("4");
    setRowsStr("3");
    setHLines([
      { pos: 1/3, angle: 0 },
      { pos: 2/3, angle: 0 }
    ]);
    setVLinesPerRow([
      [{pos: 0.25, angle: 0}, {pos: 0.5, angle: 0}, {pos: 0.75, angle: 0}],
      [{pos: 0.25, angle: 0}, {pos: 0.5, angle: 0}, {pos: 0.75, angle: 0}],
      [{pos: 0.25, angle: 0}, {pos: 0.5, angle: 0}, {pos: 0.75, angle: 0}]
    ]);
    setSelectedLine(null);
    setPieceTransforms({});
    setPieceNames({});
    setSelectedPieces(new Set());
    setPreviewMode('grid');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const getCanvasContext = async () => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image for processing'));
        img.src = imagePreviewUrl!;
      });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) throw new Error('Could not get 2d context from canvas');
      
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      return { img, ctx, canvas };
  };

  const handleUpscale = () => {
    if (!imageFile || !imageSize) return;
    setIsUpscaling(true);
    
    const img = new Image();
    img.src = imagePreviewUrl!;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const newW = imageSize.width * 2;
      const newH = imageSize.height * 2;
      canvas.width = newW;
      canvas.height = newH;
      
      // Better quality upscale
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, newW, newH);
      
      canvas.toBlob((blob) => {
        if (blob) {
          const file = new File([blob], imageFile.name.replace(/\.[^/.]+$/, "") + "_upscaled.png", { type: 'image/png' });
          processFile(file);
        }
        setIsUpscaling(false);
      }, 'image/png');
    };
  };

  const handleSharpen = () => {
    if (!imageFile || !imagePreviewUrl) return;
    setIsSharpening(true);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imagePreviewUrl;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setIsSharpening(false);
        return;
      }

      const w = img.width;
      const h = img.height;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, w, h);
      const pixels = imageData.data;
      const copy = new Uint8ClampedArray(pixels);

      // Sharpen Kernel (Laplacian-like)
      // [ 0  -1   0]
      // [-1   5  -1]
      // [ 0  -1   0]
      const kernel = [
        0, -1,  0,
       -1,  5, -1,
        0, -1,  0
      ];

      for (let i = 0; i < pixels.length; i += 4) {
        let r = 0, g = 0, b = 0;
        const x = (i / 4) % w;
        const y = Math.floor((i / 4) / w);

        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const scy = Math.min(h - 1, Math.max(0, y + ky));
            const scx = Math.min(w - 1, Math.max(0, x + kx));
            const srcOff = (scy * w + scx) * 4;
            const weight = kernel[(ky + 1) * 3 + (kx + 1)];
            
            r += copy[srcOff] * weight;
            g += copy[srcOff + 1] * weight;
            b += copy[srcOff + 2] * weight;
          }
        }

        pixels[i] = Math.min(255, Math.max(0, r));
        pixels[i+1] = Math.min(255, Math.max(0, g));
        pixels[i+2] = Math.min(255, Math.max(0, b));
      }

      ctx.putImageData(imageData, 0, 0);
      
      canvas.toBlob((blob) => {
        if (blob) {
          const file = new File([blob], imageFile.name.replace(/\.[^/.]+$/, "") + "_sharpened.png", { type: 'image/png' });
          processFile(file);
        }
        setIsSharpening(false);
      }, 'image/png');
    };
  };

  const handleAutoDetectGrid = async () => {
    if (!imageFile || !imagePreviewUrl || !imageSize) return;
    
    const apiKey = (process as any).env.GEMINI_API_KEY;
    if (!apiKey) {
      setError("Gemini API Key is missing. Please set GEMINI_API_KEY in your environment variables.");
      return;
    }

    setIsDetectingGrid(true);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey });
      
      const response = await fetch(imagePreviewUrl);
      const blob = await response.blob();
      const reader = new FileReader();
      const base64Data = await new Promise<string>((resolve) => {
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(blob);
      });

      const prompt = `Analyze this sprite sheet.
Count the number of columns and rows of character sprites.
Determine if the vertical dividing lines between columns should be slated/angled.
Return a JSON object with this exact structure:
{
  "columns": number,
  "rows": number,
  "vLinesAngles": [
    // Array of arrays. One array per row.
    // Each inner array contains the angles (in degrees, from -75 to 75) for the vertical lines in that row.
    // For example, if there are 4 columns, there are 3 vertical lines between them. So the inner array should have 3 numbers.
    // E.g., for 3 columns, 2 rows: [[0, 5], [-5, 0]]
  ]
}
Only output the JSON object, NO markdown formatting, NO extra text.`;

      const genResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: blob.type,
              },
            },
            {
              text: prompt,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
        }
      });

      let text = '';
      for (const part of genResponse.candidates?.[0]?.content?.parts || []) {
        if (part.text) {
          text = part.text;
          break;
        }
      }
      
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        const jsonStr = text.replace(/\`\`\`json\n?/g, '').replace(/\`\`\`\n?/g, '').trim();
        data = JSON.parse(jsonStr);
      }

      if (data && data.columns && data.rows) {
        const c = Math.round(Number(data.columns)) || 1;
        const r = Math.round(Number(data.rows)) || 1;
        setColumnsStr(c.toString());
        setRowsStr(r.toString());
        
        let h: {pos: number, angle: number}[] = [];
        if (r > 0) {
          let step = 1 / r;
          for (let i = step; i < 0.9999; i += step) h.push({pos: i, angle: 0});
          setHLines(h);
        }
        
        if (c > 0) {
          let vLineCount = Math.max(0, c - 1);
          let defaultAngles = Array(vLineCount).fill(0);
          
          let vPerRow: {pos: number, angle: number}[][] = [];
          
          for (let rowIdx = 0; rowIdx < r; rowIdx++) {
            let rowAngles = data.vLinesAngles?.[rowIdx] || defaultAngles;
            let v: {pos: number, angle: number}[] = [];
            let iCounter = 0;
            let step = 1 / c;
            for (let i = step; i < 0.9999; i += step) {
              v.push({ pos: i, angle: rowAngles[iCounter] || 0 });
              iCounter++;
            }
            vPerRow.push(v);
          }
          setVLinesPerRow(vPerRow);
        } else {
          setVLinesPerRow(Array.from({ length: h.length + 1 }, () => []));
        }
        setPieceTransforms({});
        setPieceNames({});
      }

    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Failed to auto-detect grid with AI.");
    } finally {
      setIsDetectingGrid(false);
    }
  };

  const handleAIExpand = async () => {
    if (!imageFile || !imagePreviewUrl || !imageSize) return;
    
    const apiKey = (process as any).env.GEMINI_API_KEY;
    if (!apiKey) {
      setError("Gemini API Key is missing. Please set GEMINI_API_KEY in your environment variables.");
      return;
    }

    setIsExpandingAI(true);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey });
      
      const response = await fetch(imagePreviewUrl);
      const blob = await response.blob();
      const reader = new FileReader();
      const base64Data = await new Promise<string>((resolve) => {
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(blob);
      });

      // Target resolution
      const targetWidth = imageSize.width + expandOffsets.left + expandOffsets.right;
      const targetHeight = imageSize.height + expandOffsets.top + expandOffsets.bottom;

      const prompt = `Expand this image to a total resolution of ${targetWidth}x${targetHeight}.
The original image is centrally located.
Extend the image by:
- ${expandOffsets.top}px at the top
- ${expandOffsets.bottom}px at the bottom
- ${expandOffsets.left}px at the left
- ${expandOffsets.right}px at the right

${expandPrompt}
Ensure the expanded areas are photorealistic, seamless, and perfectly match the existing texture, lighting, and style.`;

      const genResponse = await ai.models.generateContent({
        model: 'gemini-2.0-flash', // Stable capable model
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: blob.type,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      });

      let expandedImageUrl = '';
      for (const part of genResponse.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          expandedImageUrl = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }

      if (expandedImageUrl) {
        const res = await fetch(expandedImageUrl);
        const expandedBlob = await res.blob();
        const expandedFile = new File([expandedBlob], imageFile.name.replace(/\.[^/.]+$/, "") + "_expanded.png", { type: 'image/png' });
        
        // Reset offsets after success
        setExpandOffsets({top: 0, bottom: 0, left: 0, right: 0});
        processFile(expandedFile);
      } else {
        throw new Error("No image was generated by the AI.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Failed to expand image with AI.");
    } finally {
      setIsExpandingAI(false);
    }
  };

  const downloadFull = async () => {
    if (!imageFile || !imagePreviewUrl) return;
    setIsProcessing(true);
    try {
      const { img, canvas } = await getCanvasContext();
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setIsProcessing(false);
        return;
      }
      
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      
      canvas.toBlob((blob) => {
        if (blob) {
          const originalName = imageFile.name.replace(/\.[^/.]+$/, "");
          const fileName = `${originalName}_processed.png`;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(url);
        }
        setIsProcessing(false);
      }, 'image/png');
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
    }
  };

  const splitAndDownload = async () => {
    if (!imageFile || !imagePreviewUrl) return;
    setIsProcessing(true);
    setError(null);

    try {
      const { img, ctx, canvas } = await getCanvasContext();
      
      const zip = new JSZip();
      const baseName = downloadBaseName || 'image';
      const folderName = `${baseName}_split`;
      const imgFolder = zip.folder(folderName);
      
      const slicePromises: Promise<void>[] = [];
      const sortedHLines = [...hLines].sort((a,b)=>a.pos-b.pos);

      let index = 1;
      const W = img.width;
      const H = img.height;

      const slicesToDownload = selectedPieces.size > 0 ? selectedPieces : null;
      
      for (let row = 0; row <= sortedHLines.length; row++) {
        const rowVLines = vLinesPerRow[row] || [];
        const sortedLines = [...rowVLines].sort((a,b)=>a.pos-b.pos);
        
        const topHLine = row === 0 ? 'top' : sortedHLines[row - 1];
        const bottomHLine = row === sortedHLines.length ? 'bottom' : sortedHLines[row];

        const topCenterY = row === 0 ? 0 : sortedHLines[row - 1].pos * H;
        const bottomCenterY = row === sortedHLines.length ? H : sortedHLines[row].pos * H;
        const centerY = (topCenterY + bottomCenterY) / 2;

        for (let col = 0; col <= sortedLines.length; col++) {
           const currIndexZeroBased = index - 1;
           const shouldDownload = !slicesToDownload || slicesToDownload.has(currIndexZeroBased);
           
           if (shouldDownload) {
             const leftLine = col === 0 ? 'left' : sortedLines[col - 1];
             const rightLine = col === sortedLines.length ? 'right' : sortedLines[col];
             
             const ptTL = getIntersection(leftLine, topHLine, W, H, centerY);
             const ptBL = getIntersection(leftLine, bottomHLine, W, H, centerY);
             const ptTR = getIntersection(rightLine, topHLine, W, H, centerY);
             const ptBR = getIntersection(rightLine, bottomHLine, W, H, centerY);
             
             const minX = Math.max(0, Math.floor(Math.min(ptTL.x, ptBL.x, ptTR.x, ptBR.x)));
             const maxX = Math.min(W, Math.ceil(Math.max(ptTL.x, ptBL.x, ptTR.x, ptBR.x)));
             
             const topY = Math.min(ptTL.y, ptTR.y);
             const bottomY = Math.max(ptBL.y, ptBR.y);

             const slicePromise = new Promise<void>((resolve, reject) => {
                 const sliceW = Math.max(1, Math.round(maxX - minX));
                 const sliceH = Math.max(1, Math.round(bottomY - topY));
                 
                 const pieceIndexKey = index - 1;
                 const t = pieceTransforms[pieceIndexKey] || { rotation: 0, flipH: false, flipV: false };
  
                 canvas.width = sliceW;
                 canvas.height = sliceH;
                 ctx.clearRect(0, 0, sliceW, sliceH);

                 ctx.imageSmoothingEnabled = true;
                 ctx.imageSmoothingQuality = 'high';
                 
                 ctx.save();
                 ctx.translate(sliceW / 2, sliceH / 2);
                 ctx.rotate((t.rotation || 0) * Math.PI / 180);
                 ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
                 ctx.translate(-sliceW / 2, -sliceH / 2);
  
                 // Polygon crop for slanted cuts
                 ctx.beginPath();
                 ctx.moveTo(Math.round(ptTL.x - minX), Math.round(ptTL.y - topY));
                 ctx.lineTo(Math.round(ptTR.x - minX), Math.round(ptTR.y - topY));
                 ctx.lineTo(Math.round(ptBR.x - minX), Math.round(ptBR.y - topY));
                 ctx.lineTo(Math.round(ptBL.x - minX), Math.round(ptBL.y - topY));
                 ctx.closePath();
                 ctx.clip();
                 
                 ctx.drawImage(img, minX, Math.round(topY), sliceW, sliceH, 0, 0, sliceW, sliceH);
                 ctx.restore();
  
                 canvas.toBlob((blob) => {
                   if (blob) {
                     const indexStr = index.toString().padStart(2, '0');
                     const customName = pieceNames[pieceIndexKey]?.trim();
                     const fileName = customName ? `${customName}.png` : `${baseName}_slice_${indexStr}.png`;
                     
                     if (downloadAsZip) {
                       imgFolder!.file(fileName, blob);
                     } else {
                       const downloadUrl = URL.createObjectURL(blob);
                       const tempLink = document.createElement('a');
                       tempLink.href = downloadUrl;
                       tempLink.download = fileName;
                       document.body.appendChild(tempLink);
                       tempLink.click();
                       document.body.removeChild(tempLink);
                       // small timeout to allow browser to register the download before revoking
                       setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
                     }
                     resolve();
                   } else {
                     reject(new Error(`Failed to create blob for slice ${row},${col}`));
                   }
                 }, imageFile.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 1.0);
             });
             
             if (!downloadAsZip) {
                 await slicePromise; // await sequentially to avoid browser blocking multiple rapid downloads
                 await new Promise(r => setTimeout(r, 50)); 
             } else {
                 slicePromises.push(slicePromise);
             }
           }
           
           index++;
        }
      }

      if (downloadAsZip) {
          await Promise.all(slicePromises);
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          const downloadUrl = URL.createObjectURL(zipBlob);
          const tempLink = document.createElement('a');
          tempLink.href = downloadUrl;
          tempLink.download = `${folderName}.zip`;
          
          document.body.appendChild(tempLink);
          tempLink.click();
          document.body.removeChild(tempLink);
          URL.revokeObjectURL(downloadUrl);
      }

    } catch (err: any) {
      setError(err?.message || 'An error occurred while processing the image.');
    } finally {
      setIsProcessing(false);
    }
  };

  const splitAndSaveToLibrary = async () => {
    if (!imageFile || !imagePreviewUrl) return;
    setIsProcessing(true);
    setError(null);

    try {
      const { img, ctx, canvas } = await getCanvasContext();
      const baseName = downloadBaseName || 'image';
      
      const newItems: LibraryItem[] = [];
      const slicePromises: Promise<void>[] = [];
      const sortedHLines = [...hLines].sort((a,b)=>a.pos-b.pos);
      
      let index = 1;
      const W = img.width;
      const H = img.height;
      const slicesToSave = selectedPieces.size > 0 ? selectedPieces : null;
      
      for (let row = 0; row <= sortedHLines.length; row++) {
        const rowVLines = vLinesPerRow[row] || [];
        const sortedLines = [...rowVLines].sort((a,b)=>a.pos-b.pos);
        
        const topHLine = row === 0 ? 'top' : sortedHLines[row - 1];
        const bottomHLine = row === sortedHLines.length ? 'bottom' : sortedHLines[row];

        const topCenterY = row === 0 ? 0 : sortedHLines[row - 1].pos * H;
        const bottomCenterY = row === sortedHLines.length ? H : sortedHLines[row].pos * H;
        const centerY = (topCenterY + bottomCenterY) / 2;

        for (let col = 0; col <= sortedLines.length; col++) {
           const currIndexZeroBased = index - 1;
           const shouldSave = !slicesToSave || slicesToSave.has(currIndexZeroBased);
           
           if (shouldSave) {
             const leftLine = col === 0 ? 'left' : sortedLines[col - 1];
             const rightLine = col === sortedLines.length ? 'right' : sortedLines[col];
             
             const ptTL = getIntersection(leftLine, topHLine, W, H, centerY);
             const ptBL = getIntersection(leftLine, bottomHLine, W, H, centerY);
             const ptTR = getIntersection(rightLine, topHLine, W, H, centerY);
             const ptBR = getIntersection(rightLine, bottomHLine, W, H, centerY);
             
             const minX = Math.max(0, Math.floor(Math.min(ptTL.x, ptBL.x, ptTR.x, ptBR.x)));
             const maxX = Math.min(W, Math.ceil(Math.max(ptTL.x, ptBL.x, ptTR.x, ptBR.x)));
             
             const topY = Math.min(ptTL.y, ptTR.y);
             const bottomY = Math.max(ptBL.y, ptBR.y);
             
             const slicePromise = new Promise<void>((resolve, reject) => {
                 const sliceW = Math.max(1, Math.round(maxX - minX));
                 const sliceH = Math.max(1, Math.round(bottomY - topY));
                 
                 const pieceIndexKey = index - 1;
                 const t = pieceTransforms[pieceIndexKey] || { rotation: 0, flipH: false, flipV: false };
  
                 canvas.width = sliceW;
                 canvas.height = sliceH;
                 ctx.clearRect(0, 0, sliceW, sliceH);
                 ctx.imageSmoothingEnabled = true;
                 ctx.imageSmoothingQuality = 'high';
                 
                 ctx.save();
                 ctx.translate(sliceW / 2, sliceH / 2);
                 ctx.rotate((t.rotation || 0) * Math.PI / 180);
                 ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
                 ctx.translate(-sliceW / 2, -sliceH / 2);
  
                 ctx.beginPath();
                 ctx.moveTo(Math.round(ptTL.x - minX), Math.round(ptTL.y - topY));
                 ctx.lineTo(Math.round(ptTR.x - minX), Math.round(ptTR.y - topY));
                 ctx.lineTo(Math.round(ptBR.x - minX), Math.round(ptBR.y - topY));
                 ctx.lineTo(Math.round(ptBL.x - minX), Math.round(ptBL.y - topY));
                 ctx.closePath();
                 ctx.clip();
                 
                 ctx.drawImage(img, minX, Math.round(topY), sliceW, sliceH, 0, 0, sliceW, sliceH);
                 ctx.restore();
  
                 canvas.toBlob((blob) => {
                   if (blob) {
                     const indexStr = index.toString().padStart(2, '0');
                     const customName = pieceNames[pieceIndexKey]?.trim();
                     const fileName = customName ? `${customName}.png` : `${baseName}_slice_${indexStr}.png`;
                     
                     newItems.push({
                        id: Math.random().toString(36).substring(2, 9) + Date.now(),
                        blob,
                        name: fileName,
                        previewUrl: URL.createObjectURL(blob)
                     });
                     resolve();
                   } else {
                     reject(new Error(`Failed to create blob for slice ${row},${col}`));
                   }
                 }, imageFile.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 1.0);
             });
             slicePromises.push(slicePromise);
           }
           index++;
        }
      }
      
      await Promise.all(slicePromises);
      setLibraryItems(prev => [...prev, ...newItems]);
      setShowLibrary(true);
    } catch (err: any) {
      setError(err?.message || 'An error occurred while saving to library.');
    } finally {
      setIsProcessing(false);
    }
  };

  // --- Stitcher Logic ---
  const addStitchFiles = (files: FileList) => {
    setError(null);
    const newFiles: StitchFile[] = [];
    const promises: Promise<void>[] = [];

    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) {
        setError('Only image files are allowed in Stitcher.');
        return;
      }
      const p = new Promise<void>((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          newFiles.push({
            id: Math.random().toString(36).substring(2, 9) + Date.now(),
            file,
            previewUrl: url,
            width: img.width,
            height: img.height,
            rotation: 0,
            flipH: false,
            flipV: false,
            name: file.name.substring(0, file.name.lastIndexOf('.')) || 'image'
          });
          resolve();
        };
        img.onerror = () => {
          resolve(); // skip bad images
        };
        img.src = url;
      });
      promises.push(p);
    });

    Promise.all(promises).then(() => {
      if (newFiles.length > 0) {
        setStitchFiles((prev) => [...prev, ...newFiles]);
      }
    });
  };

  const rotateStitchFile = (id: string, degree: number) => {
    setStitchFiles(prev => prev.map(f => {
      if (f.id === id) {
        let nextRot = (f.rotation + degree) % 360;
        if (nextRot < 0) nextRot += 360;
        return { ...f, rotation: nextRot };
      }
      return f;
    }));
  };

  const flipStitchFile = (id: string, dir: 'h' | 'v') => {
    setStitchFiles(prev => prev.map(f => {
      if (f.id === id) {
        return {
          ...f,
          flipH: dir === 'h' ? !f.flipH : f.flipH,
          flipV: dir === 'v' ? !f.flipV : f.flipV
        };
      }
      return f;
    }));
  };

  const moveStitchFile = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === stitchFiles.length - 1) return;
    
    setStitchFiles(prev => {
      const nextList = [...prev];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      const temp = nextList[index];
      nextList[index] = nextList[targetIndex];
      nextList[targetIndex] = temp;
      return nextList;
    });
  };

  const removeStitchFile = (id: string) => {
    setStitchFiles(prev => {
      const target = prev.find(f => f.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter(f => f.id !== id);
    });
  };

  const clearStitchFiles = () => {
    stitchFiles.forEach((file) => URL.revokeObjectURL(file.previewUrl));
    setStitchFiles([]);
    if (stitchPreviewUrl) {
      URL.revokeObjectURL(stitchPreviewUrl);
      setStitchPreviewUrl(null);
    }
    if (stitchFileInputRef.current) stitchFileInputRef.current.value = '';
  };

  const downloadStitched = async () => {
    if (stitchFiles.length === 0 || !stitchPreviewUrl) return;
    setIsProcessing(true);
    try {
      const response = await fetch(stitchPreviewUrl);
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const tempLink = document.createElement('a');
      tempLink.href = downloadUrl;
      tempLink.download = `stitched_image_${Date.now()}.png`;
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
      URL.revokeObjectURL(downloadUrl);
    } catch (e) {
      setError('Failed to download stitched image.');
    } finally {
      setIsProcessing(false);
    }
  };

  const saveStitchedToLibrary = async () => {
    if (stitchFiles.length === 0 || !stitchPreviewUrl) return;
    setIsProcessing(true);
    try {
      const response = await fetch(stitchPreviewUrl);
      const blob = await response.blob();
      const name = `stitched_${Date.now()}.png`;
      const newItem: LibraryItem = {
        id: Math.random().toString(36).substring(2, 9) + Date.now(),
        blob,
        name,
        previewUrl: URL.createObjectURL(blob)
      };
      setLibraryItems(prev => [...prev, newItem]);
      setShowLibrary(true);
    } catch (e) {
      setError('Failed to save stitched image to library.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStitchFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addStitchFiles(e.target.files);
    }
  };

  const handleStitchDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleStitchDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addStitchFiles(e.dataTransfer.files);
    }
  };

  useEffect(() => {
    if (currentTool !== 'stitcher' || stitchFiles.length === 0) {
      if (stitchPreviewUrl) {
        URL.revokeObjectURL(stitchPreviewUrl);
        setStitchPreviewUrl(null);
      }
      return;
    }

    let isCancelled = false;
    
    const generateStitchedImage = async () => {
      try {
        const imgs = await Promise.all(
          stitchFiles.map(async (file) => {
            const img = await loadImage(file.previewUrl);
            return { file, img };
          })
        );
        
        if (isCancelled) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const items = imgs.map(({ file, img }) => {
          const rotationRad = (file.rotation * Math.PI) / 180;
          const cos = Math.abs(Math.cos(rotationRad));
          const sin = Math.abs(Math.sin(rotationRad));
          
          const scaleMult = file.scale !== undefined ? file.scale : 1.0;
          
          // Kích thước chưa zoom (Standard scale = 1.0) để làm nền chuẩn hóa đồng bộ
          const stdW = file.customWidth || img.width;
          const stdH = file.customHeight || img.height;

          const stdRw = stdW * cos + stdH * sin;
          const stdRh = stdW * sin + stdH * cos;

          // Kích thước cuối cùng đã nhân scale cá nhân
          const baseW = stdW * scaleMult;
          const baseH = stdH * scaleMult;

          const rw = baseW * cos + baseH * sin;
          const rh = baseW * sin + baseH * cos;

          return {
            file,
            img,
            rw,
            rh,
            stdRw,
            stdRh,
            baseW,
            baseH,
            scaleMult
          };
        });

        const N = items.length;
        let canvasW = 0;
        let canvasH = 0;

        interface DrawBox {
          img: HTMLImageElement;
          dx: number;
          dy: number;
          dw: number;
          dh: number;
          rotation: number;
          flipH: boolean;
          flipV: boolean;
        }
        const drawBoxes: DrawBox[] = [];

        if (stitchLayout === 'horizontal') {
          let targetH = 0;
          if (stitchResizeMode === 'match-max') {
            targetH = Math.max(...items.map(i => i.stdRh));
          } else if (stitchResizeMode === 'match-min') {
            targetH = Math.min(...items.map(i => i.stdRh));
          } else {
            targetH = -1;
          }

          const scaledItems = items.map((item) => {
            let itemH = item.stdRh;
            let itemW = item.stdRw;
            let matchScale = 1;
            if (targetH > 0) {
              matchScale = targetH / itemH;
              itemH = targetH;
              itemW = itemW * matchScale;
            }
            return {
              ...item,
              stdDw: itemW,
              stdDh: itemH,
              dw: itemW * item.scaleMult,
              dh: itemH * item.scaleMult
            };
          });

          const maxStdH = Math.max(...scaledItems.map(i => i.stdDh));

          let currentX = stitchPadding;
          scaledItems.forEach((item) => {
            let stdTop = stitchPadding;
            if (stitchAlignment === 'center') {
              stdTop = stitchPadding + (maxStdH - item.stdDh) / 2;
            } else if (stitchAlignment === 'end') {
              stdTop = stitchPadding + (maxStdH - item.stdDh);
            }

            const dx = currentX - (item.dw - item.stdDw) / 2 + (item.file.offsetX || 0);
            const dy = stdTop - (item.dh - item.stdDh) / 2 + (item.file.offsetY || 0);

            drawBoxes.push({
              img: item.img,
              dx,
              dy,
              dw: item.dw,
              dh: item.dh,
              rotation: item.file.rotation,
              flipH: item.file.flipH,
              flipV: item.file.flipV
            });
            currentX += item.stdDw + stitchGap;
          });

        } else if (stitchLayout === 'vertical') {
          let targetW = 0;
          if (stitchResizeMode === 'match-max') {
            targetW = Math.max(...items.map(i => i.stdRw));
          } else if (stitchResizeMode === 'match-min') {
            targetW = Math.min(...items.map(i => i.stdRw));
          } else {
            targetW = -1;
          }

          const scaledItems = items.map((item) => {
            let itemW = item.stdRw;
            let itemH = item.stdRh;
            let matchScale = 1;
            if (targetW > 0) {
              matchScale = targetW / itemW;
              itemW = targetW;
              itemH = itemH * matchScale;
            }
            return {
              ...item,
              stdDw: itemW,
              stdDh: itemH,
              dw: itemW * item.scaleMult,
              dh: itemH * item.scaleMult
            };
          });

          const maxStdW = Math.max(...scaledItems.map(i => i.stdDw));

          let currentY = stitchPadding;
          scaledItems.forEach((item) => {
            let stdLeft = stitchPadding;
            if (stitchAlignment === 'center') {
              stdLeft = stitchPadding + (maxStdW - item.stdDw) / 2;
            } else if (stitchAlignment === 'end') {
              stdLeft = stitchPadding + (maxStdW - item.stdDw);
            }

            const dx = stdLeft - (item.dw - item.stdDw) / 2 + (item.file.offsetX || 0);
            const dy = currentY - (item.dh - item.stdDh) / 2 + (item.file.offsetY || 0);

            drawBoxes.push({
              img: item.img,
              dx,
              dy,
              dw: item.dw,
              dh: item.dh,
              rotation: item.file.rotation,
              flipH: item.file.flipH,
              flipV: item.file.flipV
            });
            currentY += item.stdDh + stitchGap;
          });

        } else if (stitchLayout === 'grid') {
          const useRowsMode = stitchGridMode === 'rows';
          const rowsCount = Math.max(1, stitchRows);
          const colsCount = useRowsMode ? Math.ceil(items.length / rowsCount) : Math.max(1, stitchColumns);

          let maxCellW = Math.max(...items.map(i => i.stdRw));
          let maxCellH = Math.max(...items.map(i => i.stdRh));

          if (stitchResizeMode === 'match-min') {
            maxCellW = Math.min(...items.map(i => i.stdRw));
            maxCellH = Math.min(...items.map(i => i.stdRh));
          }

          items.forEach((item, idx) => {
            let r = 0;
            let c = 0;
            if (useRowsMode) {
              c = Math.floor(idx / rowsCount);
              r = idx % rowsCount;
            } else {
              r = Math.floor(idx / colsCount);
              c = idx % colsCount;
            }

            const cellX = stitchPadding + c * (maxCellW + stitchGap);
            const cellY = stitchPadding + r * (maxCellH + stitchGap);

            let stdDw = item.stdRw;
            let stdDh = item.stdRh;
            if (stitchResizeMode !== 'original') {
              const matchScale = Math.min(maxCellW / item.stdRw, maxCellH / item.stdRh);
              stdDw = item.stdRw * matchScale;
              stdDh = item.stdRh * matchScale;
            }

            const dw = stdDw * item.scaleMult;
            const dh = stdDh * item.scaleMult;

            let stdLeft = cellX;
            let stdTop = cellY;

            if (stitchAlignment === 'center') {
              stdLeft = cellX + (maxCellW - stdDw) / 2;
              stdTop = cellY + (maxCellH - stdDh) / 2;
            } else if (stitchAlignment === 'end') {
              stdLeft = cellX + (maxCellW - stdDw);
              stdTop = cellY + (maxCellH - stdDh);
            }

            const dx = stdLeft - (dw - stdDw) / 2 + (item.file.offsetX || 0);
            const dy = stdTop - (dh - stdDh) / 2 + (item.file.offsetY || 0);

            drawBoxes.push({
              img: item.img,
              dx,
              dy,
              dw,
              dh,
              rotation: item.file.rotation,
              flipH: item.file.flipH,
              flipV: item.file.flipV
            });
          });
        }

        // Calculate the bounding box of all drawn items to design perfect canvas dimensions
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        drawBoxes.forEach((box) => {
          if (box.dx < minX) minX = box.dx;
          if (box.dy < minY) minY = box.dy;
          if (box.dx + box.dw > maxX) maxX = box.dx + box.dw;
          if (box.dy + box.dh > maxY) maxY = box.dy + box.dh;
        });

        if (drawBoxes.length > 0 && minX !== Infinity) {
          canvasW = (maxX - minX) + stitchPadding * 2;
          canvasH = (maxY - minY) + stitchPadding * 2;

          const shiftX = stitchPadding - minX;
          const shiftY = stitchPadding - minY;

          drawBoxes.forEach((box) => {
            box.dx += shiftX;
            box.dy += shiftY;
          });
        }

        if (canvasW <= 0 || canvasH <= 0) return;
        canvas.width = canvasW;
        canvas.height = canvasH;

        if (stitchBgColor === 'transparent') {
          ctx.clearRect(0, 0, canvasW, canvasH);
        } else {
          ctx.fillStyle = stitchBgColor;
          ctx.fillRect(0, 0, canvasW, canvasH);
        }

        drawBoxes.forEach((box) => {
          drawImageWithTransform(
            ctx,
            box.img,
            box.dx,
            box.dy,
            box.dw,
            box.dh,
            box.rotation,
            box.flipH,
            box.flipV
          );
        });

        if (isCancelled) return;

        canvas.toBlob((blob) => {
          if (blob && !isCancelled) {
            const url = URL.createObjectURL(blob);
            setStitchPreviewUrl((oldUrl) => {
              if (oldUrl) URL.revokeObjectURL(oldUrl);
              return url;
            });
          }
        }, 'image/png');

      } catch (err) {
        console.error('Error generating stitch preview:', err);
      }
    };

    generateStitchedImage();

    return () => {
      isCancelled = true;
    };
  }, [
    stitchFiles,
    stitchLayout,
    stitchColumns,
    stitchGap,
    stitchPadding,
    stitchBgColor,
    stitchAlignment,
    stitchResizeMode,
    currentTool
  ]);

  // --- BG Remover Logic ---
  const handleBgDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const processBgFiles = (files: FileList | File[]) => {
    const validFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (validFiles.length === 0) {
      setError('Please select valid image files.');
      return;
    }
    
    setBgFiles(prev => {
      const remainingSlots = Math.max(0, 5 - prev.length);
      const filesToAdd = validFiles.slice(0, remainingSlots);
      
      if (validFiles.length > remainingSlots) {
        alert(`Bạn chỉ có thể xử lý tối đa 5 ảnh cùng lúc. ${validFiles.length - filesToAdd.length} file đã bị bỏ qua.`);
      }
      
      const newBgFiles: BgFile[] = filesToAdd.map(f => ({
        id: Math.random().toString(36).substr(2, 9),
        file: f,
        previewUrl: URL.createObjectURL(f),
        status: 'pending'
      }));
      return [...prev, ...newBgFiles];
    });
  };

  const handleBgDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files) processBgFiles(e.dataTransfer.files);
  };

  const handleBgFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processBgFiles(e.target.files);
    if (bgFileInputRef.current) bgFileInputRef.current.value = '';
  };

  const removeBgFile = (id: string) => {
    setBgFiles(prev => {
      const file = prev.find(f => f.id === id);
      if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
      if (file?.resultUrl) URL.revokeObjectURL(file.resultUrl);
      return prev.filter(f => f.id !== id);
    });
  };

  const clearBgFiles = () => {
    bgFiles.forEach(f => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      if (f.resultUrl) URL.revokeObjectURL(f.resultUrl);
    });
    setBgFiles([]);
  };

  const runBgRemoval = async () => {
    setIsRemovingBg(true);
    
    // Process concurrently (up to 5)
    const promises = bgFiles.map(async (bf) => {
       // Update to processing
       setBgFiles(prev => prev.map(f => f.id === bf.id ? { ...f, status: 'processing' } : f));
       
       try {
         // Use the AI model (Bria RMBG 1.4 via transformers.js)
         const blob = await removeBackgroundV2(bf.previewUrl, bgSensitivity, keepPrompt, removePrompt);
         const resultUrl = URL.createObjectURL(blob);
         setBgFiles(prev => prev.map(f => f.id === bf.id ? { ...f, status: 'done', resultBlob: blob, resultUrl } : f));
       } catch (err: any) {
         setBgFiles(prev => prev.map(f => f.id === bf.id ? { ...f, status: 'error', errorMsg: err.message } : f));
       }
    });

    await Promise.all(promises);
    setIsRemovingBg(false);
  };

  const downloadAllBg = async () => {
    const doneFiles = bgFiles.filter(f => f.status === 'done' && f.resultBlob);
    if (doneFiles.length === 0) return;
    
    setIsProcessing(true);
    try {
      if (downloadAsZip) {
          const zip = new JSZip();
          const folderName = `background_removed_${doneFiles.length}_images`;
          const imgFolder = zip.folder(folderName);
          
          doneFiles.forEach(f => {
             const originalName = f.file.name.substring(0, f.file.name.lastIndexOf('.')) || 'image';
             imgFolder!.file(`${originalName}_no_bg.png`, f.resultBlob!);
          });
          
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          const downloadUrl = URL.createObjectURL(zipBlob);
          const tempLink = document.createElement('a');
          tempLink.href = downloadUrl;
          tempLink.download = `${folderName}.zip`;
          
          document.body.appendChild(tempLink);
          tempLink.click();
          document.body.removeChild(tempLink);
          URL.revokeObjectURL(downloadUrl);
      } else {
          for (const f of doneFiles) {
             const originalName = f.file.name.substring(0, f.file.name.lastIndexOf('.')) || 'image';
             const fileName = `${originalName}_no_bg.png`;
             const downloadUrl = URL.createObjectURL(f.resultBlob!);
             
             const tempLink = document.createElement('a');
             tempLink.href = downloadUrl;
             tempLink.download = fileName;
             document.body.appendChild(tempLink);
             tempLink.click();
             document.body.removeChild(tempLink);
             
             // small timeout sequentially downloading
             await new Promise(r => setTimeout(r, 100));
             URL.revokeObjectURL(downloadUrl);
          }
      }
    } catch(e) {
      setError('Error downloading files');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-screen w-full bg-[#0f172a] text-slate-200 flex flex-col font-sans overflow-hidden">
      
      {/* Top Navigation Bar */}
      <header className="h-14 bg-[#1e293b] border-b border-slate-700 flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center shadow-md shadow-indigo-500/20">
              <Scissors className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight hidden md:block text-white">Slice&nbsp;&amp;&nbsp;Dice</span>
          </div>
          
          {/* Tool Switcher */}
          <div className="flex items-center bg-slate-800 p-1 rounded-lg border border-slate-705 shadow-inner">
            <button 
              onClick={() => setCurrentTool('splitter')} 
              className={`px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all ${currentTool === 'splitter' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-250 hover:bg-slate-750'}`}
            >
              Image Splitter
            </button>
            <button 
              onClick={() => setCurrentTool('bg-remover')} 
              className={`px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center gap-1.5 ${currentTool === 'bg-remover' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-250 hover:bg-slate-750'}`}
            >
              Bg Remover
              <span className="hidden sm:inline bg-indigo-500/20 text-indigo-300 text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider font-bold">New</span>
            </button>
            <button 
              onClick={() => setCurrentTool('ai-expand')} 
              className={`px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center gap-1.5 ${currentTool === 'ai-expand' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-250 hover:bg-slate-750'}`}
            >
              AI Expand
              <Maximize2 className="w-3 h-3 text-indigo-400" />
            </button>
            <button 
              onClick={() => setCurrentTool('stitcher')} 
              className={`px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center gap-1.5 ${currentTool === 'stitcher' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-250 hover:bg-slate-750'}`}
            >
              Stitcher
              <Grid3X3 className="w-3 h-3 text-indigo-400" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowLibrary(true)}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium text-slate-300 border border-slate-700 hover:border-slate-600 shadow transition-all relative"
            title="Open stored images library"
          >
            <Library className="w-4 h-4 text-yellow-500" />
            <span className="hidden sm:inline">Library</span>
            {libraryItems.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-indigo-500 text-white text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full shadow-md animate-pulse">
                {libraryItems.length}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Contextual Options Toolbar (Secondary Action Bar) */}
      {((currentTool === 'splitter' && imagePreviewUrl) || 
        (currentTool === 'ai-expand' && imagePreviewUrl) || 
        (currentTool === 'bg-remover' && bgFiles.length > 0) || 
        (currentTool === 'stitcher' && stitchFiles.length > 0)) && (
        <div className="bg-[#1b2537] border-b border-slate-800 py-2.5 px-6 flex flex-wrap items-center justify-between gap-4 shrink-0 transition-all z-10 w-full">
          
          {/* Leftside Metadata or Instructions */}
          <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
            {currentTool === 'splitter' && (
              <>
                <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px]">Image Splitter Workspace</span>
                {originalSize && (
                  <span className="hidden sm:inline text-slate-400 font-medium">• {originalSize.width}x{originalSize.height} original • {totalSlices} grid slices</span>
                )}
              </>
            )}
            {currentTool === 'ai-expand' && (
              <>
                <span className="bg-pink-500/10 text-pink-400 border border-pink-500/20 px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px]">AI Expansion Sandbox</span>
                {originalSize && (
                  <span className="hidden sm:inline text-slate-400 font-medium">• Canvas: {originalSize.width}x{originalSize.height} • Define margins in sidebar</span>
                )}
              </>
            )}
            {currentTool === 'bg-remover' && (
              <>
                <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px]">Remover Sandbox</span>
                <span className="hidden sm:inline text-slate-400 font-medium">• {bgFiles.length} files • {bgFiles.filter(f => f.status === 'done').length} processed</span>
              </>
            )}
            {currentTool === 'stitcher' && (
              <>
                <span className="bg-indigo-500/10 text-violet-400 border border-violet-550/20 px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px]">Stitch Compositor</span>
                <span className="hidden sm:inline text-slate-400 font-medium">• {stitchFiles.length} slice blocks • Mode: {stitchLayout}</span>
              </>
            )}
          </div>

          {/* Rightside Action Buttons */}
          <div className="flex items-center flex-wrap gap-2 sm:gap-3">
            {/* Global ZIP Option where applicable */}
            {((currentTool === 'splitter' && imagePreviewUrl) || (currentTool === 'bg-remover' && bgFiles.length > 0)) && (
              <label className="flex items-center gap-2 text-xs text-slate-300 font-semibold cursor-pointer bg-slate-800/40 hover:bg-slate-800/80 px-2.5 py-1.5 rounded-lg border border-slate-700/80 hover:border-slate-600 transition-colors">
                <input 
                  type="checkbox" 
                  checked={downloadAsZip} 
                  onChange={(e) => setDownloadAsZip(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-700 text-indigo-500 focus:ring-indigo-500/50"
                />
                Save as ZIP
              </label>
            )}

            {/* Splitter Actions */}
            {currentTool === 'splitter' && imagePreviewUrl && (
              <>
                <button 
                  onClick={handleReset}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold transition-colors border border-slate-700 text-slate-300 hover:text-white"
                  title="Upload a different image"
                >
                  Reset Image
                </button>

                <div className="w-px h-5 bg-slate-800 hidden sm:block"></div>

                <button
                  onClick={handleUpscale}
                  disabled={isUpscaling || isProcessing || isSharpening}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold transition-all border border-slate-700 text-slate-300 hover:text-white flex items-center gap-1.5 shadow-sm"
                  title="Upscale image resolution by 2x"
                >
                  {isUpscaling ? <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" /> : <ZoomIn className="w-3 h-3 text-indigo-450" />}
                  Upscale 2x
                </button>

                <button 
                  onClick={splitAndSaveToLibrary}
                  disabled={isProcessing || isUpscaling}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold transition-all border border-slate-700 flex items-center gap-1.5 shadow-sm text-yellow-400 border-yellow-400/20 hover:border-yellow-400/30"
                  title="Create slices and save them into Library"
                >
                  <Archive className="w-3 h-3" />
                  Save Slices to Library
                </button>

                <button 
                  onClick={downloadFull}
                  disabled={isProcessing || isUpscaling}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold transition-all border border-slate-700 flex items-center gap-1.5 shadow-sm text-slate-300 hover:text-white"
                  title="Download the reconstructed image with current dimensions and filter effects"
                >
                  <ImageIcon className="w-3 h-3 text-indigo-400" />
                  Save Full Image
                </button>

                <button 
                  onClick={splitAndDownload}
                  disabled={isProcessing || isUpscaling}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-indigo-600/10 flex items-center gap-1.5"
                >
                  {isProcessing ? (
                    <><RefreshCw className="w-3.5 h-3.5 animate-spin text-white" /> Splitting...</>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5 text-white" />
                      {selectedPieces.size > 0 ? `Download Selected (${selectedPieces.size})` : `Download Grid (${totalSlices})`}
                    </>
                  )}
                </button>
              </>
            )}

            {/* AI Expand Actions */}
            {currentTool === 'ai-expand' && imagePreviewUrl && (
              <>
                <button 
                  onClick={() => setExpandOffsets({top: 0, bottom: 0, left: 0, right: 0})}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold border border-slate-700 text-slate-300 hover:text-white transition-colors"
                >
                  Reset Handles
                </button>
                <div className="w-px h-5 bg-slate-800"></div>
                <button
                  onClick={handleAIExpand}
                  disabled={isExpandingAI || isProcessing}
                  className="px-4 py-1.5 bg-pink-600 hover:bg-pink-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-pink-600/10 flex items-center gap-1.5"
                >
                  {isExpandingAI ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-white" /> : <Wand2 className="w-3.5 h-3.5 text-white" />}
                  Generate Expansion
                </button>
              </>
            )}

            {/* Background Remover Actions */}
            {currentTool === 'bg-remover' && bgFiles.length > 0 && (
              <>
                <button 
                  onClick={clearBgFiles}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold border border-slate-700 text-slate-300 hover:text-white transition-colors"
                >
                  Clear All
                </button>
                {bgFiles.some(f => f.status === 'done') && (
                  <button 
                    onClick={downloadAllBg}
                    disabled={isProcessing}
                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-emerald-600/15 flex items-center gap-1.5"
                  >
                    {isProcessing ? <><RefreshCw className="w-3.5 h-3.5 animate-spin text-white" /> Saving...</> : <><Download className="w-3.5 h-3.5 text-white" /> Download All</>}
                  </button>
                )}
              </>
            )}

            {/* Image Stitcher Actions */}
            {currentTool === 'stitcher' && stitchFiles.length > 0 && (
              <>
                <button 
                  onClick={clearStitchFiles}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold border border-slate-700 text-slate-300 hover:text-white transition-colors"
                >
                  Clear All Pieces
                </button>

                <button 
                  onClick={saveStitchedToLibrary}
                  disabled={isProcessing}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold border border-slate-700 text-yellow-400 border-yellow-400/20 hover:border-yellow-400/30 flex items-center gap-1.5 transition-all"
                  title="Save final composite into library to edit/slice again"
                >
                  <Archive className="w-3 h-3 hover:text-yellow-300" />
                  Save to Library
                </button>

                <button 
                  onClick={downloadStitched}
                  disabled={isProcessing}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-indigo-600/15 flex items-center gap-1.5"
                  title="Download the compiled stitched image"
                >
                  {isProcessing ? (
                    <><RefreshCw className="w-3.5 h-3.5 animate-spin text-white" /> Stitching...</>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5 text-white" />
                      Download Stitch
                    </>
                  )}
                </button>
              </>
            )}
          </div>

        </div>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        
        {/* === SIDEBARS === */}
        {((imagePreviewUrl && (currentTool === 'splitter' || currentTool === 'ai-expand')) || (currentTool === 'stitcher')) && (
          <>
            {/* Splitter Sidebar */}
            {currentTool === 'splitter' && (
              <aside className="w-80 bg-[#1e293b] border-r border-slate-700 p-6 flex flex-col gap-8 shrink-0 overflow-y-auto">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Export Settings</label>
                  <div className="space-y-4 mb-8">
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium">Base Filename</span>
                      </div>
                      <input
                        type="text"
                        value={downloadBaseName}
                        onChange={(e) => setDownloadBaseName(e.target.value)}
                        placeholder="e.g. hero-image"
                        className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    </div>
                  </div>

                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Transform Properties</label>
                  <div className="space-y-4 mb-8">
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium">Rotation ({rotation}°)</span>
                        <div className="flex gap-2">
                          <button onClick={() => setRotation(r => (r - 90) % 360)} className="hover:text-indigo-400" title="Rotate -90°"><RotateCcw className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setRotation(r => (r + 90) % 360)} className="hover:text-indigo-400" title="Rotate +90°"><RotateCw className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setRotation(0)} className="hover:text-red-400" title="Reset angle"><RefreshCw className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        value={rotation}
                        onChange={(e) => setRotation(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      />
                    </div>
                    
                    <div className="flex gap-3">
                      <div className="flex-1">
                         <span className="text-sm font-medium mb-2 block">Width</span>
                         <input
                           type="number"
                           value={resizeWidth}
                           onChange={(e) => {
                             const val = e.target.value;
                             setResizeWidth(val);
                             if (maintainAspect && originalSize && parseInt(val)) {
                               setResizeHeight(Math.round(parseInt(val) * (originalSize.height / originalSize.width)).toString());
                             }
                           }}
                           className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                         />
                      </div>
                      <div className="flex-1">
                         <span className="text-sm font-medium mb-2 block">Height</span>
                         <input
                           type="number"
                           value={resizeHeight}
                           onChange={(e) => {
                             const val = e.target.value;
                             setResizeHeight(val);
                             if (maintainAspect && originalSize && parseInt(val)) {
                               setResizeWidth(Math.round(parseInt(val) * (originalSize.width / originalSize.height)).toString());
                             }
                           }}
                           className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                         />
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <input 
                        type="checkbox" 
                        id="maintain" 
                        checked={maintainAspect}
                        onChange={(e) => setMaintainAspect(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-slate-900"
                      />
                      <label htmlFor="maintain" className="text-xs text-slate-400 cursor-pointer">Lock aspect ratio</label>
                    </div>

                    <button
                      onClick={applyTransform}
                      disabled={isApplyingTransform}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-xs font-semibold uppercase tracking-wider transition-colors disabled:opacity-50"
                    >
                      {isApplyingTransform ? 'Applying...' : 'Apply Transform'}
                    </button>
                  </div>

                  {selectedLine && (
                    <div className="space-y-4 mb-8">
                      <label className="text-xs font-bold uppercase tracking-wider text-indigo-400 block flex justify-between items-center">
                        {selectedLine.type === 'v' ? 'Column Line Angle' : 'Row Line Angle'}
                        <button onClick={() => setSelectedLine(null)} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
                      </label>
                      <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-md">
                        <div className="flex justify-between text-xs text-slate-400 mb-1">
                          <span>Angle:</span>
                          <span className="font-semibold text-white">
                            {selectedLine.type === 'v' 
                              ? `${vLinesPerRow[selectedLine.rIdx]?.[selectedLine.cIdx]?.angle || 0}°` 
                              : `${hLines[selectedLine.idx]?.angle || 0}°`}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="-75"
                          max="75"
                          value={selectedLine.type === 'v' 
                            ? (vLinesPerRow[selectedLine.rIdx]?.[selectedLine.cIdx]?.angle || 0) 
                            : (hLines[selectedLine.idx]?.angle || 0)}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            if (selectedLine.type === 'v') {
                              setVLinesPerRow(prev => {
                                const next = [...prev];
                                const nextRow = [...(next[selectedLine.rIdx] || [])];
                                if (nextRow[selectedLine.cIdx]) {
                                  nextRow[selectedLine.cIdx] = { ...nextRow[selectedLine.cIdx], angle: val };
                                }
                                next[selectedLine.rIdx] = nextRow;
                                return next;
                              });
                            } else {
                              setHLines(prev => {
                                const next = [...prev];
                                if (next[selectedLine.idx]) {
                                  next[selectedLine.idx] = { ...next[selectedLine.idx], angle: val };
                                }
                                return next;
                              });
                            }
                          }}
                          className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>
                    </div>
                  )}

                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Grid Configuration</label>
                  <div className="space-y-4 mb-8">
                    <button
                      onClick={handleAutoDetectGrid}
                      disabled={isDetectingGrid}
                      className="w-full py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 rounded text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20"
                    >
                      {isDetectingGrid ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      {isDetectingGrid ? 'Detecting...' : 'Auto-Detect with AI'}
                    </button>
                    <div>
                      <span className="text-sm font-medium mb-1 block">Columns</span>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={columnsStr}
                        onChange={(e) => {
                          const cleanVal = e.target.value.replace(/[^0-9]/g, '');
                          setColumnsStr(cleanVal);
                          updateGridLines(cleanVal, rowsStr);
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <span className="text-sm font-medium mb-1 block">Rows</span>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={rowsStr}
                        onChange={(e) => {
                          const cleanVal = e.target.value.replace(/[^0-9]/g, '');
                          setRowsStr(cleanVal);
                          updateGridLines(columnsStr, cleanVal);
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>

                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Preview Mode</label>
                  <div className="grid grid-cols-2 gap-2 mb-8">
                    <button 
                      onClick={() => setPreviewMode('grid')}
                      className={`p-3 rounded border text-xs font-semibold transition-colors ${previewMode === 'grid' ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-400'}`}
                    >
                      Grid
                    </button>
                    <button 
                      onClick={() => setPreviewMode('exploded')}
                      className={`p-3 rounded border text-xs font-semibold transition-colors ${previewMode === 'exploded' ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-400'}`}
                    >
                      Pieces
                    </button>
                  </div>
                </div>

                <div className="mt-auto pt-4 border-t border-slate-700/50">
                  <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                    <h4 className="text-xs font-bold uppercase text-slate-500 mb-2 italic">File Info</h4>
                    {imageSize && (
                      <div className="flex justify-between text-xs py-1">
                        <span className="text-slate-400">Image:</span>
                        <span>{imageSize.width}x{imageSize.height}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs py-1">
                      <span className="text-slate-400">Total:</span>
                      <span>{totalSlices} slices</span>
                    </div>
                  </div>
                </div>
              </aside>
            )}

            {/* AI Expand Sidebar */}
            {currentTool === 'ai-expand' && (
              <aside className="w-80 bg-[#1e293b] border-r border-slate-700 p-6 flex flex-col gap-8 shrink-0 overflow-y-auto">
                <div className="animate-in fade-in slide-in-from-right-4 duration-500">
                  <label className="text-xs font-bold uppercase tracking-wider text-pink-400 block mb-4 flex items-center gap-2 font-mono">
                    <Maximize2 className="w-4 h-4" />
                    Expansion Mode
                  </label>
                  
                  <div className="space-y-6">
                    <div className="bg-pink-500/5 border border-pink-500/10 p-4 rounded-xl shadow-inner space-y-4">
                      <div className="flex gap-3">
                        <div className="flex-1">
                           <span className="text-xs font-bold text-slate-500 mb-2 block uppercase">Target Width</span>
                           <div className="bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono flex items-center justify-between">
                             {expandWidth}
                             <span className="text-[10px] text-slate-500">px</span>
                           </div>
                        </div>
                        <div className="flex-1">
                           <span className="text-xs font-bold text-slate-500 mb-2 block uppercase">Target Height</span>
                           <div className="bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono flex items-center justify-between">
                             {expandHeight}
                             <span className="text-[10px] text-slate-500">px</span>
                           </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-300 font-mono">
                        <div className="p-2 border border-slate-700 bg-slate-800 rounded flex justify-between">
                          <span>LEFT</span>
                          <span className={expandOffsets.left > 0 ? "text-pink-400" : ""}>+{expandOffsets.left}</span>
                        </div>
                        <div className="p-2 border border-slate-700 bg-slate-800 rounded flex justify-between">
                          <span>RIGHT</span>
                          <span className={expandOffsets.right > 0 ? "text-pink-400" : ""}>+{expandOffsets.right}</span>
                        </div>
                        <div className="p-2 border border-slate-700 bg-slate-800 rounded flex justify-between">
                          <span>TOP</span>
                          <span className={expandOffsets.top > 0 ? "text-pink-400" : ""}>+{expandOffsets.top}</span>
                        </div>
                        <div className="p-2 border border-slate-700 bg-slate-800 rounded flex justify-between">
                          <span>BOTTOM</span>
                          <span className={expandOffsets.bottom > 0 ? "text-pink-400" : ""}>+{expandOffsets.bottom}</span>
                        </div>
                      </div>
                      
                      <div>
                        <div className="flex justify-between items-center mb-2">
                           <span className="text-xs font-bold text-slate-500 uppercase">AI Prompt</span>
                           <Sparkles className="w-3 h-3 text-pink-500" />
                        </div>
                        <textarea
                          value={expandPrompt}
                          onChange={(e) => setExpandPrompt(e.target.value)}
                          placeholder="What should the AI fill the extra space with?"
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-pink-500 transition-colors h-28 resize-none shadow-inner"
                        />
                      </div>

                      <button
                        onClick={handleAIExpand}
                        disabled={isExpandingAI || isProcessing}
                        className="w-full py-4 bg-gradient-to-br from-pink-600 to-indigo-600 hover:from-pink-500 hover:to-indigo-500 rounded-xl text-xs font-black uppercase tracking-[0.2em] transition-all disabled:opacity-50 flex items-center justify-center gap-3 shadow-xl shadow-pink-500/10 border border-white/10"
                      >
                        {isExpandingAI ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Wand2 className="w-5 h-5" />}
                        {isExpandingAI ? 'Generating...' : 'Magic Expand'}
                      </button>

                      <button
                        onClick={() => setExpandOffsets({top: 0, bottom: 0, left: 0, right: 0})}
                        className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-500 hover:text-slate-300 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all border border-slate-700/50"
                      >
                        Reset Extension
                      </button>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-800/30 border border-slate-700/50">
                      <p className="text-[11px] text-slate-500 leading-relaxed text-center italic">
                        Drag the <span className="text-pink-400 font-bold not-italic">glowing handles</span> on the image preview to visually define the region.
                      </p>
                    </div>
                  </div>
                </div>
              </aside>
            )}

            {/* Stitcher Sidebar */}
            {currentTool === 'stitcher' && (
              <aside className="w-80 bg-[#1e293b] border-r border-slate-700 p-6 flex flex-col gap-8 shrink-0 overflow-y-auto custom-scrollbar">
                <div className="space-y-6">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-indigo-400 block mb-3">Layout Arrangement</label>
                    <div className="grid grid-cols-3 gap-2">
                      <button 
                        onClick={() => setStitchLayout('horizontal')}
                        className={`py-2 px-3 rounded text-xs font-semibold border flex flex-col items-center justify-center gap-1.5 transition-all ${
                          stitchLayout === 'horizontal' ? 'bg-indigo-600 border-indigo-500 text-white shadow-md' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                        }`}
                      >
                        <FlipHorizontal className="w-4 h-4" />
                        <span>Horizontal</span>
                      </button>
                      <button 
                        onClick={() => setStitchLayout('vertical')}
                        className={`py-2 px-3 rounded text-xs font-semibold border flex flex-col items-center justify-center gap-1.5 transition-all ${
                          stitchLayout === 'vertical' ? 'bg-indigo-600 border-indigo-500 text-white shadow-md' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                        }`}
                      >
                        <FlipVertical className="w-4 h-4" />
                        <span>Vertical</span>
                      </button>
                      <button 
                        onClick={() => setStitchLayout('grid')}
                        className={`py-2 px-3 rounded text-xs font-semibold border flex flex-col items-center justify-center gap-1.5 transition-all ${
                          stitchLayout === 'grid' ? 'bg-indigo-600 border-indigo-500 text-white shadow-md' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                        }`}
                      >
                        <Grid3X3 className="w-4 h-4" />
                        <span>Grid</span>
                      </button>
                    </div>
                  </div>

                  {stitchLayout === 'grid' && (
                    <div className="space-y-4">
                      <div>
                        <label className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 block mb-2">Chế Độ Grid (Grid Mode)</label>
                        <div className="flex bg-slate-800 p-0.5 rounded-lg border border-slate-700 justify-between">
                          <button 
                            type="button"
                            onClick={() => setStitchGridMode('columns')}
                            className={`w-1/2 py-1 text-[11px] rounded transition-all font-medium ${stitchGridMode === 'columns' ? 'bg-indigo-600 text-white shadow-sm font-semibold' : 'text-slate-400 hover:text-white'}`}
                          >
                            Cố định Cột (Cols)
                          </button>
                          <button 
                            type="button"
                            onClick={() => setStitchGridMode('rows')}
                            className={`w-1/2 py-1 text-[11px] rounded transition-all font-medium ${stitchGridMode === 'rows' ? 'bg-indigo-600 text-white shadow-sm font-semibold' : 'text-slate-400 hover:text-white'}`}
                          >
                            Cố định Hàng (Rows)
                          </button>
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between mb-1.5">
                          <span className={`text-xs font-semibold ${stitchGridMode === 'columns' ? 'text-indigo-400 font-bold' : 'text-slate-400'}`}>
                            Số cột (Grid Columns)
                          </span>
                          <span className="text-[10px] font-mono text-slate-400">{stitchColumns} col(s)</span>
                        </div>
                        <input 
                          type="range"
                          min="1"
                          max="10"
                          value={stitchColumns}
                          onChange={(e) => {
                            setStitchColumns(parseInt(e.target.value));
                            setStitchGridMode('columns');
                          }}
                          className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between mb-1.5">
                          <span className={`text-xs font-semibold ${stitchGridMode === 'rows' ? 'text-indigo-400 font-bold' : 'text-slate-400'}`}>
                            Số hàng (Grid Rows)
                          </span>
                          <span className="text-[10px] font-mono text-slate-400">{stitchRows} row(s)</span>
                        </div>
                        <input 
                          type="range"
                          min="1"
                          max="10"
                          value={stitchRows}
                          onChange={(e) => {
                            setStitchRows(parseInt(e.target.value));
                            setStitchGridMode('rows');
                          }}
                          className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex justify-between mb-2">
                      <span className="text-sm font-medium">Image Gap</span>
                      <span className="text-xs font-mono text-slate-400">{stitchGap}px</span>
                    </div>
                    <input 
                      type="range"
                      min="0"
                      max="100"
                      value={stitchGap}
                      onChange={(e) => setStitchGap(parseInt(e.target.value))}
                      className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between mb-2">
                      <span className="text-sm font-medium">Outer Padding</span>
                      <span className="text-xs font-mono text-slate-400">{stitchPadding}px</span>
                    </div>
                    <input 
                      type="range"
                      min="0"
                      max="100"
                      value={stitchPadding}
                      onChange={(e) => setStitchPadding(parseInt(e.target.value))}
                      className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium block mb-2">Background Color</label>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => setStitchBgColor('transparent')}
                        className={`w-8 h-8 rounded border checkerboard-bg transition-all ${stitchBgColor === 'transparent' ? 'ring-2 ring-indigo-500 border-white' : 'border-slate-700'}`}
                        title="Transparent"
                      />
                      <button 
                        onClick={() => setStitchBgColor('#ffffff')}
                        className={`w-8 h-8 rounded border bg-white transition-all ${stitchBgColor === '#ffffff' ? 'ring-2 ring-indigo-500 border-slate-400' : 'border-slate-700'}`}
                        title="White"
                      />
                      <button 
                        onClick={() => setStitchBgColor('#000000')}
                        className={`w-8 h-8 rounded border bg-black transition-all ${stitchBgColor === '#000000' ? 'ring-2 ring-indigo-500 border-slate-400' : 'border-slate-700'}`}
                        title="Black"
                      />
                      <button 
                        onClick={() => setStitchBgColor('#0f172a')}
                        className={`w-8 h-8 rounded border bg-[#0f172a] transition-all ${stitchBgColor === '#0f172a' ? 'ring-2 ring-indigo-500 border-slate-400' : 'border-slate-700'}`}
                        title="Slate Dark"
                      />
                      <input 
                        type="color"
                        value={stitchBgColor.startsWith('#') ? stitchBgColor : '#000000'}
                        onChange={(e) => setStitchBgColor(e.target.value)}
                        className="w-8 h-8 bg-transparent cursor-pointer rounded border border-slate-700"
                        title="Custom Color"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-indigo-400 block mb-2">Alignment</label>
                    <div className="flex bg-slate-800 p-0.5 rounded-lg border border-slate-700 justify-between">
                      <button 
                        onClick={() => setStitchAlignment('start')}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${stitchAlignment === 'start' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        Start
                      </button>
                      <button 
                        onClick={() => setStitchAlignment('center')}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${stitchAlignment === 'center' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        Center
                      </button>
                      <button 
                        onClick={() => setStitchAlignment('end')}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${stitchAlignment === 'end' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        End
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-indigo-400 block mb-2">Tương Tác Chuột (Drag Mode)</label>
                    <div className="flex bg-slate-800 p-0.5 rounded-lg border border-slate-700 justify-between">
                      <button 
                        onClick={() => setStitchMouseMode('reorder')}
                        className={`w-1/2 py-1.5 rounded-md text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${stitchMouseMode === 'reorder' ? 'bg-indigo-600 text-white shadow-sm font-semibold' : 'text-slate-400 hover:text-white'}`}
                        title="Drag and drop elements to prioritize/rearrange order sequence on canvas"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Sắp thứ tự
                      </button>
                      <button 
                        onClick={() => setStitchMouseMode('offset')}
                        className={`w-1/2 py-1.5 rounded-md text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${stitchMouseMode === 'offset' ? 'bg-indigo-600 text-white shadow-sm font-semibold' : 'text-slate-400 hover:text-white'}`}
                        title="Directly pull and drag slices manually with pointer tool custom coordinates offsets"
                      >
                        <Move className="w-3.5 h-3.5" />
                        Dịch tự do
                      </button>
                    </div>
                    {stitchMouseMode === 'offset' && (
                      <div className="mt-2.5 p-2 bg-slate-800/40 border border-slate-700/60 rounded-lg text-[10px] text-slate-400 font-medium leading-relaxed">
                        💡 Click & kéo trực tiếp mảnh ảnh bất kỳ trên bảng tương tác để di chuyển. Bạn có thể nhấn nút <strong className="text-indigo-400">“Xoá dịch chuyển”</strong> để khôi phục vị trí ban đầu.
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-indigo-400 block mb-2">Resizing Mode</label>
                    <div className="space-y-2">
                      <button 
                        onClick={() => setStitchResizeMode('match-max')}
                        className={`w-full py-2 px-3 text-left rounded text-xs font-medium border transition-all flex items-center justify-between ${
                          stitchResizeMode === 'match-max' ? 'bg-indigo-600/20 border-indigo-500 text-white font-semibold' : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}
                      >
                        Scale to Match Tallest/Widest
                        <CheckCircle2 className={`w-4 h-4 ${stitchResizeMode === 'match-max' ? 'text-indigo-400' : 'opacity-0'}`} />
                      </button>
                      <button 
                        onClick={() => setStitchResizeMode('match-min')}
                        className={`w-full py-2 px-3 text-left rounded text-xs font-medium border transition-all flex items-center justify-between ${
                          stitchResizeMode === 'match-min' ? 'bg-indigo-600/20 border-indigo-500 text-white font-semibold' : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}
                      >
                        Scale to Match Shortest/Narrowest
                        <CheckCircle2 className={`w-4 h-4 ${stitchResizeMode === 'match-min' ? 'text-indigo-400' : 'opacity-0'}`} />
                      </button>
                      <button 
                        onClick={() => setStitchResizeMode('original')}
                        className={`w-full py-2 px-3 text-left rounded text-xs font-medium border transition-all flex items-center justify-between ${
                          stitchResizeMode === 'original' ? 'bg-indigo-600/20 border-indigo-500 text-white font-semibold' : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}
                      >
                        Original Dimensions (No Stretch)
                        <CheckCircle2 className={`w-4 h-4 ${stitchResizeMode === 'original' ? 'text-indigo-400' : 'opacity-0'}`} />
                      </button>
                    </div>
                  </div>

                  {stitchFiles.length > 0 && (
                    <div className="pt-4 border-t border-slate-800">
                      <label className="text-xs font-bold uppercase tracking-wider text-indigo-400 block mb-3 flex justify-between items-center">
                        <span>Items ({stitchFiles.length})</span>
                        <span className="text-[10px] text-slate-500 italic">Order/Transforms</span>
                      </label>
                      <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
                        {stitchFiles.map((item, idx) => (
                          <div key={item.id} className="bg-slate-800/80 border border-slate-700/60 rounded p-2 flex items-center gap-2 group">
                            <div className="w-10 h-10 shrink-0 bg-slate-900 rounded border border-slate-700 flex items-center justify-center overflow-hidden checkerboard-bg shadow">
                              <img src={item.previewUrl} alt="prev" className="max-w-full max-h-full object-contain" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <input 
                                type="text"
                                value={item.name}
                                onChange={(e) => {
                                  setStitchFiles(prev => prev.map(f => f.id === item.id ? { ...f, name: e.target.value } : f));
                                }}
                                className="w-full bg-transparent text-xs text-slate-200 outline-none border-b border-transparent focus:border-indigo-500 truncate"
                              />
                              <span className="text-[9px] font-mono text-slate-500">{item.width}x{item.height}</span>
                            </div>
                            <div className="flex flex-col gap-1 shrink-0">
                              <div className="flex gap-1 justify-end">
                                <button 
                                  onClick={() => moveStitchFile(idx, 'up')}
                                  disabled={idx === 0}
                                  className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-20 text-[10px]"
                                  title="Move Up"
                                >
                                  ▲
                                </button>
                                <button 
                                  onClick={() => moveStitchFile(idx, 'down')}
                                  disabled={idx === stitchFiles.length - 1}
                                  className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-20 text-[10px]"
                                  title="Move Down"
                                >
                                  ▼
                                </button>
                              </div>
                              <div className="flex gap-1 justify-end">
                                <button 
                                  onClick={() => rotateStitchFile(item.id, 90)}
                                  className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-indigo-400"
                                  title="Rotate 90"
                                >
                                  <RotateCw className="w-2.5 h-2.5" />
                                </button>
                                <button 
                                  onClick={() => flipStitchFile(item.id, 'h')}
                                  className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-indigo-400"
                                  title="Flip Horizontal"
                                >
                                  <FlipHorizontal className="w-2.5 h-2.5" />
                                </button>
                                <button 
                                  onClick={() => removeStitchFile(item.id)}
                                  className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-red-400"
                                  title="Remove"
                                >
                                  <Trash2 className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                </div>
              </aside>
            )}
          </>
        )}

        {/* === MAIN WORKSPACE === */}
        {currentTool === 'splitter' || currentTool === 'ai-expand' ? (
          <main 
            className={`flex-1 bg-[#0f172a] relative overflow-auto transition-colors duration-300 ${dragActive ? 'bg-indigo-500/10' : ''}`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            {!imagePreviewUrl ? (
                <div className="w-full h-full flex items-center justify-center p-8 md:p-12">
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="w-full max-w-lg"
                  >
                    <div
                      className={`relative flex flex-col items-center justify-center w-full min-h-[400px] border-2 border-dashed rounded-lg transition-all duration-300 ease-in-out cursor-pointer overflow-hidden ${
                        dragActive ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01]' : 'border-slate-600 bg-[#1e293b]/50 hover:border-slate-500 hover:bg-[#1e293b]'
                      }`}
                      onDragEnter={handleDrag}
                      onDragLeave={handleDrag}
                      onDragOver={handleDrag}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png, image/jpeg, image/webp"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      <div className="flex flex-col items-center text-center p-6 pointer-events-none">
                        <div className="w-16 h-16 rounded-full bg-slate-800 text-indigo-400 flex items-center justify-center mb-6 shadow-sm border border-slate-700">
                          <UploadCloud className="w-8 h-8" />
                        </div>
                        <h3 className="text-xl font-semibold mb-2">Upload any image to split</h3>
                        <p className="text-slate-400 max-w-xs mb-6 text-sm">
                          Drag and drop your file here, or click to browse. Supports JPEG, PNG, and WebP.
                        </p>
                        <span className="px-5 py-2.5 bg-indigo-600 text-white rounded font-medium text-sm shadow-md hover:bg-indigo-500 transition-colors pointer-events-auto">
                          Select File
                        </span>
                      </div>
                    </div>
                  </motion.div>
                </div>
              ) : (
                <div 
                  className="min-w-full min-h-full flex items-center justify-center p-8 md:p-12 transition-all"
                  style={{
                    width: zoomLevel > 1 ? `${zoomLevel * 100}%` : '100%',
                    height: zoomLevel > 1 ? `${zoomLevel * 100}%` : '100%',
                  }}
                >
                  {/* Image Canvas Area */}
                  {currentTool === 'ai-expand' && (
                     <div className="relative flex items-center justify-center">
                        <div 
                          className="relative shadow-2xl rounded shadow-black/50 group flex overflow-hidden bg-slate-900 checkerboard-bg" 
                          style={{ 
                             transform: `scale(${zoomLevel})`,
                             transformOrigin: 'center center',
                             transition: 'transform 0.2s ease-out'
                          }}
                        >
                          <img
                            src={imagePreviewUrl}
                            alt="AI Expand Preview"
                            onLoad={handleImageLoad}
                            className="block max-w-[calc(100vw-28rem)] max-h-[calc(100vh-12rem)] object-contain transition-opacity duration-300 rounded pointer-events-none"
                            style={{
                              paddingTop: expandOffsets.top * zoomLevel,
                              paddingBottom: expandOffsets.bottom * zoomLevel,
                              paddingLeft: expandOffsets.left * zoomLevel,
                              paddingRight: expandOffsets.right * zoomLevel,
                              boxSizing: 'content-box'
                            }}
                          />
                          
                          {/* DRAGGABLE HANDLES */}
                          {imageSize && !isExpandingAI && (
                            <div className="absolute inset-0 pointer-events-none">
                              {/* Top Handle */}
                              <div 
                                className="absolute left-1/2 -top-2 w-12 h-6 -translate-x-1/2 cursor-ns-resize pointer-events-auto flex flex-col items-center group/h z-20"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const startY = e.clientY;
                                  const startVal = expandOffsets.top;
                                  const onMove = (moveEvt: MouseEvent) => {
                                    const delta = startY - moveEvt.clientY;
                                    setExpandOffsets(prev => ({ ...prev, top: Math.max(0, startVal + delta / zoomLevel) }));
                                  };
                                  const onUp = () => {
                                    window.removeEventListener('mousemove', onMove);
                                    window.removeEventListener('mouseup', onUp);
                                  };
                                  window.addEventListener('mousemove', onMove);
                                  window.addEventListener('mouseup', onUp);
                                }}
                              >
                                 <div className="w-8 h-1.5 bg-pink-500 rounded-full shadow-[0_0_10px_rgba(236,72,153,0.8)] group-hover/h:h-2 transition-all"></div>
                              </div>
                              
                              {/* Bottom Handle */}
                              <div 
                                className="absolute left-1/2 -bottom-2 w-12 h-6 -translate-x-1/2 cursor-ns-resize pointer-events-auto flex flex-col items-center justify-end group/h z-20"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const startY = e.clientY;
                                  const startVal = expandOffsets.bottom;
                                  const onMove = (moveEvt: MouseEvent) => {
                                    const delta = moveEvt.clientY - startY;
                                    setExpandOffsets(prev => ({ ...prev, bottom: Math.max(0, startVal + delta / zoomLevel) }));
                                  };
                                  const onUp = () => {
                                    window.removeEventListener('mousemove', onMove);
                                    window.removeEventListener('mouseup', onUp);
                                  };
                                  window.addEventListener('mousemove', onMove);
                                  window.addEventListener('mouseup', onUp);
                                }}
                              >
                                 <div className="w-8 h-1.5 bg-pink-500 rounded-full shadow-[0_0_10px_rgba(236,72,153,0.8)] group-hover/h:h-2 transition-all"></div>
                              </div>
                              
                              {/* Left Handle */}
                              <div 
                                className="absolute top-1/2 -left-2 w-6 h-12 -translate-y-1/2 cursor-ew-resize pointer-events-auto flex items-center group/h z-20"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const startX = e.clientX;
                                  const startVal = expandOffsets.left;
                                  const onMove = (moveEvt: MouseEvent) => {
                                    const delta = startX - moveEvt.clientX;
                                    setExpandOffsets(prev => ({ ...prev, left: Math.max(0, startVal + delta / zoomLevel) }));
                                  };
                                  const onUp = () => {
                                    window.removeEventListener('mousemove', onMove);
                                    window.removeEventListener('mouseup', onUp);
                                  };
                                  window.addEventListener('mousemove', onMove);
                                  window.addEventListener('mouseup', onUp);
                                }}
                              >
                                 <div className="w-1.5 h-8 bg-pink-500 rounded-full shadow-[0_0_10px_rgba(236,72,153,0.8)] group-hover/h:w-2 transition-all"></div>
                              </div>
                              
                              {/* Right Handle */}
                              <div 
                                className="absolute top-1/2 -right-2 w-6 h-12 -translate-y-1/2 cursor-ew-resize pointer-events-auto flex items-center justify-end group/h z-20"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const startX = e.clientX;
                                  const startVal = expandOffsets.right;
                                  const onMove = (moveEvt: MouseEvent) => {
                                    const delta = moveEvt.clientX - startX;
                                    setExpandOffsets(prev => ({ ...prev, right: Math.max(0, startVal + delta / zoomLevel) }));
                                  };
                                  const onUp = () => {
                                    window.removeEventListener('mousemove', onMove);
                                    window.removeEventListener('mouseup', onUp);
                                  };
                                  window.addEventListener('mousemove', onMove);
                                  window.addEventListener('mouseup', onUp);
                                }}
                              >
                                 <div className="w-1.5 h-8 bg-pink-500 rounded-full shadow-[0_0_10px_rgba(236,72,153,0.8)] group-hover/h:w-2 transition-all"></div>
                              </div>
                            </div>
                          )}
                        </div>
                     </div>
                  )}
                  {currentTool === 'splitter' && previewMode === 'grid' && (
                      <div className="relative flex items-center justify-center">
                         <div 
                           className="relative shadow-2xl rounded shadow-black/50 group flex overflow-hidden bg-slate-900 checkerboard-bg" 
                           style={{ 
                              transform: `scale(${zoomLevel})`,
                              transformOrigin: 'center center',
                              transition: 'transform 0.2s ease-out'
                           }}
                         >
                          <img
                            ref={imageElementRef}
                            src={imagePreviewUrl}
                            alt="Preview"
                            onLoad={handleImageLoad}
                            className="block max-w-[calc(100vw-28rem)] max-h-[calc(100vh-12rem)] object-contain transition-opacity duration-300 rounded pointer-events-none"
                          />
    
                          {/* Interactive Drag Lines overlay */}
                          {imageSize && (
                            <div className="absolute top-0 left-0 right-0 bottom-0">
                              {(() => {
                                 const sortedHLines = [...hLines].sort((a,b)=>a.pos-b.pos);
                                 const hP = [0, ...sortedHLines.map(hl => hl.pos), 1];
                                 return hP.slice(0, -1).map((startH, rIdx) => {
                                   const endH = hP[rIdx + 1];
                                   const rowVLines = vLinesPerRow[rIdx] || [];
                                   
                                   return (
                                     <div 
                                       key={`row-lines-${rIdx}`} 
                                       className="absolute left-0 right-0 overflow-hidden pointer-events-none" 
                                       style={{ top: `${startH * 100}%`, height: `${(endH - startH) * 100}%` }}
                                     >
                                       {rowVLines.map((v, cIdx) => {
                                         const isSelected = selectedLine?.type === 'v' && selectedLine?.rIdx === rIdx && selectedLine?.cIdx === cIdx;
                                         return (
                                         <div
                                           key={`v-${rIdx}-${cIdx}`}
                                           className={`absolute w-8 -ml-4 cursor-col-resize flex justify-center group/line pointer-events-auto ${isSelected ? 'z-20' : 'z-10'}`}
                                           style={{ 
                                              left: `${v.pos * 100}%`,
                                              top: `-50%`,
                                              height: `200%`,
                                              transform: `rotate(${v.angle}deg)`,
                                              transformOrigin: 'center center'
                                           }}
                                       onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedLine({ type: 'v', rIdx, cIdx });
                                       }}
                                       onMouseDown={(e) => {
                                         e.preventDefault();
                                         const startX = e.clientX;
                                         const startVal = rowVLines[cIdx].pos;
                                         const rect = imageElementRef.current?.getBoundingClientRect();
                                          if (!rect) return;
                                         const handleMouseMove = (me: MouseEvent) => {
                                           const delta = me.clientX - startX;
                                           const newVal = Math.max(0, Math.min(1, startVal + delta / rect.width));
                                           setVLinesPerRow(prev => {
                                               const next = [...prev];
                                               const nextRow = [...(next[rIdx] || [])];
                                               nextRow[cIdx] = { ...nextRow[cIdx], pos: newVal };
                                               next[rIdx] = nextRow;
                                               return next;
                                           });
                                         };
                                         const handleMouseUp = () => {
                                           window.removeEventListener('mousemove', handleMouseMove);
                                           window.removeEventListener('mouseup', handleMouseUp);
                                         };
                                         window.addEventListener('mousemove', handleMouseMove);
                                         window.addEventListener('mouseup', handleMouseUp);
                                       }}
                                     >
                                        <div className={`w-[1.5px] h-full ${isSelected ? 'bg-indigo-400 shadow-[0_0_8px_theme(colors.indigo.500)] w-[3px]' : 'bg-blue-500/80 shadow-[0_0_3px_rgba(0,0,0,0.5)] group-hover/line:bg-blue-400 group-hover/line:w-[3px]'} transition-all pointer-events-none`}></div>
                                     </div>
                                   )})
                                     }
                                     </div>
                                   );
                                 });
                              })()}
                              
                              {hLines.map((h, i) => {
                                const isSelected = selectedLine?.type === 'h' && selectedLine?.idx === i;
                                return (
                                  <div
                                    key={`h-${i}`}
                                    className={`absolute left-0 right-0 h-8 -mt-4 cursor-row-resize flex flex-col justify-center group/line pointer-events-auto ${isSelected ? 'z-20' : 'z-10'}`}
                                    style={{ 
                                      top: `${h.pos * 100}%`,
                                      transform: `rotate(${h.angle}deg)`,
                                      transformOrigin: 'center center'
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedLine({ type: 'h', idx: i });
                                    }}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      const startY = e.clientY;
                                      const startVal = h.pos;
                                      const rect = imageElementRef.current?.getBoundingClientRect();
                                      if (!rect) return;
                                      const handleMouseMove = (me: MouseEvent) => {
                                        const delta = me.clientY - startY;
                                        const newVal = Math.max(0, Math.min(1, startVal + delta / rect.height));
                                        setHLines(prev => {
                                            const next = [...prev];
                                            next[i] = { ...next[i], pos: newVal };
                                            return next;
                                        });
                                      };
                                      const handleMouseUp = () => {
                                        window.removeEventListener('mousemove', handleMouseMove);
                                        window.removeEventListener('mouseup', handleMouseUp);
                                      };
                                      window.addEventListener('mousemove', handleMouseMove);
                                      window.addEventListener('mouseup', handleMouseUp);
                                    }}
                                  >
                                    <div className={`h-[1.5px] w-full ${isSelected ? 'bg-indigo-400 shadow-[0_0_8px_theme(colors.indigo.500)] h-[3px]' : 'bg-green-500/80 shadow-[0_0_3px_rgba(0,0,0,0.5)] group-hover/line:bg-green-400 group-hover/line:h-[3px]'} transition-all pointer-events-none`}></div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                      {currentTool === 'splitter' && previewMode === 'exploded' && (
                        <div 
                          className="flex justify-center items-center h-[calc(100vh-12rem)] max-w-full w-full p-4"
                        >
                          <div 
                            className="relative w-full h-full"
                            style={{
                               aspectRatio: imageSize ? `${imageSize.width} / ${imageSize.height}` : 'auto',
                               maxHeight: '100%',
                               maxWidth: '100%',
                            }}
                          >
                             {(() => {
                                if (!imageSize) return null;
                                const sortedHLines = [...hLines].sort((a,b)=>a.pos-b.pos);
                                const totalRows = sortedHLines.length + 1;
                                let sliceIndex = 0;
                                const W = imageSize.width;
                                const H = imageSize.height;
    
                                return Array.from({ length: totalRows }).map((_, rIdx) => {
                                    const topHLine = rIdx === 0 ? 'top' : sortedHLines[rIdx - 1];
                                    const bottomHLine = rIdx === sortedHLines.length ? 'bottom' : sortedHLines[rIdx];

                                    const topCenterY = rIdx === 0 ? 0 : sortedHLines[rIdx - 1].pos * H;
                                    const bottomCenterY = rIdx === sortedHLines.length ? H : sortedHLines[rIdx].pos * H;
                                    const centerY = (topCenterY + bottomCenterY) / 2;
                                    
                                    const rowVLines = vLinesPerRow[rIdx] || [];
                                    const sortedLines = [...rowVLines].sort((a,b)=>a.pos-b.pos);
                                    
                                    return sortedLines.concat('right' as any).map((rightLine, cIdx) => {
                                        const leftLine = cIdx === 0 ? 'left' : sortedLines[cIdx - 1];
                                        
                                        const ptTL = getIntersection(leftLine as any, topHLine as any, W, H, centerY);
                                        const ptBL = getIntersection(leftLine as any, bottomHLine as any, W, H, centerY);
                                        const ptTR = getIntersection(rightLine as any, topHLine as any, W, H, centerY);
                                        const ptBR = getIntersection(rightLine as any, bottomHLine as any, W, H, centerY);
                                        
                                        const minX = Math.max(0, Math.floor(Math.min(ptTL.x, ptBL.x, ptTR.x, ptBR.x)));
                                        const maxX = Math.min(W, Math.ceil(Math.max(ptTL.x, ptBL.x, ptTR.x, ptBR.x)));
                                        
                                        const topY = Math.min(ptTL.y, ptTR.y);
                                        const bottomY = Math.max(ptBL.y, ptBR.y);
                                        
                                        const sliceW = Math.max(1, maxX - minX);
                                        const sliceH = Math.max(1, bottomY - topY);
                                        
                                        const currIndex = sliceIndex++;
                                        const transformData = pieceTransforms[currIndex] || { rotation: 0, flipH: false, flipV: false };
                                        const isSelected = selectedPieces.has(currIndex);
                                        
                                        const explodeX = (cIdx - sortedLines.length / 2) * 12;
                                        const explodeY = (rIdx - totalRows / 2) * 12;
    
                                        const pTL = { x: ((ptTL.x - minX) / sliceW) * 100, y: ((ptTL.y - topY) / sliceH) * 100 };
                                        const pTR = { x: ((ptTR.x - minX) / sliceW) * 100, y: ((ptTR.y - topY) / sliceH) * 100 };
                                        const pBR = { x: ((ptBR.x - minX) / sliceW) * 100, y: ((ptBR.y - topY) / sliceH) * 100 };
                                        const pBL = { x: ((ptBL.x - minX) / sliceW) * 100, y: ((ptBL.y - topY) / sliceH) * 100 };
                                        
                                        const bgPosX = Math.abs(W - sliceW) < 0.1 ? 0 : (minX / (W - sliceW)) * 100;
                                        const bgPosY = Math.abs(H - sliceH) < 0.1 ? 0 : (topY / (H - sliceH)) * 100;
    
                                        const updatePieceTransform = (e: React.MouseEvent, updates: Partial<PieceTransform>) => {
                                          e.stopPropagation();
                                          setPieceTransforms(prev => ({
                                            ...prev,
                                            [currIndex]: {
                                              ...(prev[currIndex] || { rotation: 0, flipH: false, flipV: false }),
                                              ...updates
                                            }
                                          }));
                                        };
    
                                        const toggleSelection = () => {
                                          setSelectedPieces(prev => {
                                            const next = new Set(prev);
                                            if (next.has(currIndex)) next.delete(currIndex);
                                            else next.add(currIndex);
                                            return next;
                                          });
                                        };
    
                                        return (
                                          <div 
                                            key={`${rIdx}-${cIdx}`} 
                                            onClick={toggleSelection}
                                            className={`absolute overflow-hidden rounded-sm bg-[#0f172a] checkerboard-bg group/piece shadow-md border cursor-pointer transition-all ${isSelected ? 'ring-2 ring-indigo-500 border-indigo-500 scale-[1.05] z-10' : 'hover:border-indigo-500/50 hover:shadow-indigo-500/20'}`}
                                            style={{
                                              left: `${(minX / W) * 100}%`,
                                              top: `${(topY / H) * 100}%`,
                                              width: `${(sliceW / W) * 100}%`,
                                              height: `${(sliceH / H) * 100}%`,
                                              transform: `translate(${explodeX}px, ${explodeY}px)`,
                                            }}
                                          >
                                            <div 
                                              className="w-full h-full transition-transform duration-300"
                                              style={{
                                                clipPath: `polygon(${pTL.x}% ${pTL.y}%, ${pTR.x}% ${pTR.y}%, ${pBR.x}% ${pBR.y}%, ${pBL.x}% ${pBL.y}%)`,
                                                backgroundImage: `url(${imagePreviewUrl})`,
                                                backgroundSize: `${ (W / sliceW) * 100 }% ${ (H / sliceH) * 100 }%`,
                                                backgroundPosition: `${bgPosX}% ${bgPosY}%`,
                                                transform: `rotate(${transformData.rotation}deg) scale(${transformData.flipH ? -1 : 1}, ${transformData.flipV ? -1 : 1})`,
                                              }}
                                            />
                                            
                                            {/* Selection indicator */}
                                            {isSelected && (
                                              <div className="absolute top-1 right-1 bg-indigo-500 text-white rounded-full p-0.5 z-20 shadow-lg">
                                                <CheckCircle2 className="w-3 h-3" />
                                              </div>
                                            )}
    
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/piece:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                                              <div className="flex gap-2">
                                                <button 
                                                  onClick={(e) => updatePieceTransform(e, { rotation: (transformData.rotation - 90) % 360 })}
                                                  className="p-1.5 bg-slate-800/80 hover:bg-slate-700 rounded text-white"
                                                  title="Rotate Left"
                                                >
                                                  <RotateCcw className="w-4 h-4" />
                                                </button>
                                                <button 
                                                  onClick={(e) => updatePieceTransform(e, { rotation: (transformData.rotation + 90) % 360 })}
                                                  className="p-1.5 bg-slate-800/80 hover:bg-slate-700 rounded text-white"
                                                  title="Rotate Right"
                                                >
                                                  <RotateCw className="w-4 h-4" />
                                                </button>
                                              </div>
                                              <div className="flex gap-2">
                                                <button 
                                                  onClick={(e) => updatePieceTransform(e, { flipH: !transformData.flipH })}
                                                  className={`p-1.5 rounded text-white ${transformData.flipH ? 'bg-indigo-600' : 'bg-slate-800/80 hover:bg-slate-700'}`}
                                                  title="Flip Horizontal"
                                                >
                                                  <FlipHorizontal className="w-4 h-4" />
                                                </button>
                                                <button 
                                                  onClick={(e) => updatePieceTransform(e, { flipV: !transformData.flipV })}
                                                  className={`p-1.5 rounded text-white ${transformData.flipV ? 'bg-indigo-600' : 'bg-slate-800/80 hover:bg-slate-700'}`}
                                                  title="Flip Vertical"
                                                >
                                                  <FlipVertical className="w-4 h-4" />
                                                </button>
                                              </div>
                                            </div>
                                            
                                            <div className="absolute bottom-1 left-1 right-1 z-30 flex justify-center">
                                              <input
                                                type="text"
                                                placeholder={`slice_${(currIndex + 1).toString().padStart(2, '0')}`}
                                                value={pieceNames[currIndex] || ''}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => {
                                                  setPieceNames(prev => ({...prev, [currIndex]: e.target.value}));
                                                }}
                                                className={`w-[90%] text-xs px-1.5 py-1 bg-black/80 text-white rounded backdrop-blur-sm outline-none border border-transparent focus:border-indigo-400 transition-opacity text-center placeholder:text-gray-400 ${pieceNames[currIndex] ? 'opacity-100' : 'opacity-0 group-hover/piece:opacity-100 focus:opacity-100'}`}
                                              />
                                            </div>

                                            <span className="absolute top-1 left-1 text-[10px] bg-black/70 px-1.5 py-0.5 rounded text-white shadow-sm pointer-events-none backdrop-blur-sm z-10">
                                              {currIndex + 1}
                                            </span>
                                          </div>
                                        );
                                    });
                                });
                             })()
                          }
                        </div>
                      </div>
                    )}
                  </div>
                )}
                  
                  {imagePreviewUrl && currentTool === 'splitter' && (
                    <div className="absolute bottom-8 right-8 z-50 flex bg-[#1e293b] border border-slate-700 rounded-lg shadow-2xl p-1 gap-1 items-center">
                      <button onClick={() => setZoomLevel(z => Math.max(0.25, z - 0.25))} className="p-1.5 hover:bg-slate-700 rounded text-slate-300 hover:text-white" title="Zoom Out"><ZoomOut className="w-5 h-5"/></button>
                      <span className="text-xs font-mono w-12 text-center text-slate-300">{Math.round(zoomLevel * 100)}%</span>
                      <button onClick={() => setZoomLevel(z => Math.min(5, z + 0.25))} className="p-1.5 hover:bg-slate-700 rounded text-slate-300 hover:text-white" title="Zoom In"><ZoomIn className="w-5 h-5"/></button>
                      <div className="w-px h-5 bg-slate-700 mx-1"></div>
                      <button onClick={() => setZoomLevel(1)} className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white" title="Fit to Screen"><RefreshCw className="w-4 h-4"/></button>
                    </div>
                  )}
                </main>
              ) : currentTool === 'bg-remover' ? (
                <main className="flex-1 bg-[#0f172a] p-8 overflow-y-auto flex flex-col relative w-full">
            <div className="max-w-6xl mx-auto w-full flex flex-col gap-8 pb-16">
              
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-2xl font-semibold mb-2">Bulk Background Removal</h2>
                  <p className="text-slate-400 max-w-md text-sm">
                    Upload multiple images at once (up to 5 images). We'll process them locally in your browser and provide transparent PNGs for download.
                  </p>
                </div>
                
                {bgFiles.length > 0 && (
                 <div className="flex flex-col sm:flex-row items-center gap-4 w-full">
                     <div className="flex flex-col gap-1 w-full max-w-sm">
                       <label className="text-xs font-semibold text-slate-400">Keep Prompt (Optional)</label>
                       <input 
                         type="text" 
                         value={keepPrompt} 
                         onChange={e => setKeepPrompt(e.target.value)} 
                         disabled={isRemovingBg}
                         placeholder="e.g. white clothing, hair"
                         className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 outline-none focus:border-indigo-500 w-full"
                       />
                     </div>
                     <div className="flex flex-col gap-1 w-full max-w-sm">
                       <label className="text-xs font-semibold text-slate-400">Remove Prompt (Optional)</label>
                       <input 
                         type="text" 
                         value={removePrompt} 
                         onChange={e => setRemovePrompt(e.target.value)} 
                         disabled={isRemovingBg}
                         placeholder="e.g. shadow, background"
                         className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 outline-none focus:border-indigo-500 w-full"
                       />
                     </div>
                     
                     <div className="flex flex-col gap-1 items-end sm:ml-auto">
                       <label className="text-xs font-semibold text-slate-400">AI Sensitivity: {bgSensitivity}</label>
                       <input 
                         type="range" 
                         min="-100" max="100" 
                         value={bgSensitivity} 
                         onChange={e => setBgSensitivity(Number(e.target.value))} 
                         disabled={isRemovingBg}
                         className="w-32 accent-indigo-500" 
                         title="Negative means it keeps less white, Positive keeps more white."
                       />
                     </div>
                     <button 
                       onClick={runBgRemoval}
                       disabled={isRemovingBg}
                       className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-bold transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-2 whitespace-nowrap"
                     >
                       {isRemovingBg ? (
                         <><RefreshCw className="w-5 h-5 animate-spin" /> Processing...</>
                       ) : (
                         <><Scissors className="w-5 h-5" /> Remove Backgrounds</>
                       )}
                     </button>
                   </div>
                )}
              </div>

              {/* Upload Area for BG Remover */}
              <div
                className={`relative flex flex-col items-center justify-center w-full min-h-[160px] border-2 border-dashed rounded-xl transition-all duration-300 ease-in-out cursor-pointer ${
                  dragActive ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-600 bg-[#1e293b]/50 hover:border-slate-500'
                }`}
                onDragEnter={handleBgDrag}
                onDragLeave={handleBgDrag}
                onDragOver={handleBgDrag}
                onDrop={handleBgDrop}
                onClick={() => bgFileInputRef.current?.click()}
              >
                <input
                  ref={bgFileInputRef}
                  type="file"
                  accept="image/png, image/jpeg, image/webp"
                  multiple
                  className="hidden"
                  onChange={handleBgFileChange}
                />
                <div className="flex items-center gap-4 text-slate-400 pointer-events-none">
                   <div className="w-12 h-12 rounded-full bg-slate-800 text-indigo-400 flex items-center justify-center border border-slate-700">
                     <UploadCloud className="w-6 h-6" />
                   </div>
                   <div>
                     <span className="font-semibold text-white block">Click or Drop images here</span>
                     <span className="text-xs">Supports multiple JPEG, PNG, WebP</span>
                   </div>
                </div>
              </div>

              {/* File List / Grid View */}
              {bgFiles.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {bgFiles.map(file => (
                    <motion.div 
                      key={file.id} 
                      layout
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="bg-[#1e293b] rounded-lg border border-slate-700 overflow-hidden flex flex-col group relative"
                    >
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeBgFile(file.id); }}
                        className="absolute top-2 right-2 bg-red-500/80 text-white p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-10 hover:bg-red-500"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      
                      <div className="relative aspect-square bg-[#0f172a] checkerboard-bg">
                        {/* Original Image Background (blurred if processing or done) */}
                        <img 
                          src={file.previewUrl} 
                          alt="Original" 
                          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${file.status === 'done' ? 'opacity-0' : file.status === 'processing' ? 'opacity-30 blur-sm' : 'opacity-100'}`} 
                        />
                        
                        {/* Result Image */}
                        {file.status === 'done' && file.resultUrl && (
                          <img 
                            src={file.resultUrl} 
                            alt="Result" 
                            className="absolute inset-0 w-full h-full object-contain drop-shadow-2xl" 
                          />
                        )}
                        
                        {/* Processing Spinner Overlay */}
                        {file.status === 'processing' && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0f172a]/60 backdrop-blur-sm">
                            <span className="loader-ring block w-8 h-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin"></span>
                          </div>
                        )}
                        
                        {/* Error Overlay */}
                        {file.status === 'error' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-red-900/80 text-white p-2 text-center text-xs">
                            {file.errorMsg || 'Error removing BG'}
                          </div>
                        )}
                      </div>

                      <div className="p-3 border-t border-slate-700 bg-slate-800 flex justify-between items-center group/bottom">
                        <span className="text-xs truncate text-slate-300 font-medium" title={file.file.name}>{file.file.name}</span>
                        {file.status === 'done' ? (
                          <div className="flex gap-2 items-center">
                            <a 
                              href={file.resultUrl} 
                              download={`${file.file.name.substring(0, file.file.name.lastIndexOf('.')) || 'image'}_no_bg.png`}
                              className="text-indigo-400 hover:text-indigo-300 transition-colors"
                              onClick={e => e.stopPropagation()}
                              title="Download"
                            >
                              <Download className="w-4 h-4" />
                            </a>
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          </div>
                        ) : file.status === 'pending' ? (
                          <span className="w-2 h-2 rounded-full bg-slate-500 shrink-0"></span>
                        ) : null}
                      </div>

                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </main>
        ) : (
          <main className="flex-1 bg-[#0f172a] p-8 overflow-y-auto flex flex-col relative w-full">
            <div className="max-w-6xl mx-auto w-full flex flex-col gap-8 pb-16">
              
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-slate-800 pb-6">
                <div>
                  <h2 className="text-2xl font-semibold mb-2 flex items-center gap-2">
                    <Grid3X3 className="w-6 h-6 text-indigo-400" />
                    Combine &amp; Stitch Image Pieces
                  </h2>
                  <p className="text-slate-400 max-w-2xl text-sm leading-relaxed">
                    Upload multiple images (pieces) and merge them into a single image. Adjust the layout, columns, custom spacing, outer padding, and order of each piece to compile your collage.
                  </p>
                </div>

                {stitchFiles.length > 0 && (
                  <div className="flex gap-2 shrink-0">
                    <button 
                      onClick={() => {
                        const input = stitchFileInputRef.current;
                        if (input) input.click();
                      }}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Add Pieces
                    </button>
                    {libraryItems.length > 0 && (
                      <button 
                        onClick={() => {
                          const newStitchFiles = libraryItems.map(item => {
                            const file = new File([item.blob], item.name, { type: item.blob.type });
                            return {
                              id: Math.random().toString(36).substring(2, 9) + Date.now(),
                              file,
                              previewUrl: URL.createObjectURL(item.blob),
                              width: 300,
                              height: 300,
                              rotation: 0,
                              flipH: false,
                              flipV: false,
                              name: item.name.substring(0, item.name.lastIndexOf('.')) || 'slice'
                            };
                          });
                          setStitchFiles(prev => [...prev, ...newStitchFiles]);
                        }}
                        className="px-4 py-2 bg-slate-800/60 hover:bg-slate-700 text-yellow-400 border border-yellow-500/20 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                        title="Add all pieces currently stored in your library"
                      >
                        <Archive className="w-4 h-4" />
                        Import Library ({libraryItems.length})
                      </button>
                    )}
                  </div>
                )}
              </div>

              {stitchFiles.length === 0 ? (
                <div className="w-full flex-1 flex flex-col items-center justify-center min-h-[450px]">
                  <motion.div 
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                    className="w-full max-w-2xl space-y-6"
                  >
                    <div 
                      onDragEnter={handleStitchDrag}
                      onDragOver={handleStitchDrag}
                      onDragLeave={handleStitchDrag}
                      onDrop={handleStitchDrop}
                      onClick={() => stitchFileInputRef.current?.click()}
                      className={`relative flex flex-col items-center justify-center w-full min-h-[320px] border-2 border-dashed rounded-2xl transition-all duration-300 cursor-pointer overflow-hidden ${
                        dragActive ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01]' : 'border-slate-700 bg-slate-800/35 hover:border-slate-500 hover:bg-slate-800/50'
                      }`}
                    >
                      <input 
                        ref={stitchFileInputRef}
                        type="file"
                        multiple
                        accept="image/png, image/jpeg, image/webp"
                        className="hidden"
                        onChange={handleStitchFileChange}
                      />
                      <div className="flex flex-col items-center text-center p-8 pointer-events-none">
                        <div className="w-16 h-16 rounded-2xl bg-indigo-500/15 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-6 shadow-indigo-500/5 shadow-inner">
                          <Plus className="w-8 h-8" />
                        </div>
                        <h3 className="text-xl font-semibold mb-2 text-white">Upload image pieces</h3>
                        <p className="text-slate-400 max-w-sm mb-6 text-sm">
                          Drag and drop your image files here, or click to browse. Select multiple files to combine them.
                        </p>
                        <span className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium text-sm shadow-lg pointer-events-auto transition-colors">
                          Select Pieces
                        </span>
                      </div>
                    </div>

                    {libraryItems.length > 0 && (
                      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 text-center shadow-inner flex flex-col items-center">
                        <div className="flex items-center gap-2 mb-3 text-slate-300 font-semibold text-sm">
                          <Archive className="w-4 h-4 text-yellow-500" />
                          <span>Use Previously Crop/Saved Pieces</span>
                        </div>
                        <p className="text-xs text-slate-400 max-w-sm mb-4 leading-relaxed">
                          We found some pieces in your **Library**. You can import and stitch them together immediately!
                        </p>
                        <button 
                          onClick={() => {
                            const newStitchFiles = libraryItems.map(item => {
                              const file = new File([item.blob], item.name, { type: item.blob.type });
                              return {
                                id: Math.random().toString(36).substring(2, 9) + Date.now(),
                                file,
                                previewUrl: URL.createObjectURL(item.blob),
                                width: 300, 
                                height: 300,
                                rotation: 0,
                                flipH: false,
                                flipV: false,
                                name: item.name.substring(0, item.name.lastIndexOf('.')) || 'slice'
                              };
                            });
                            setStitchFiles(newStitchFiles);
                          }}
                          className="px-4 py-2 bg-yellow-500/10 hover:bg-yellow-500 text-yellow-400 hover:text-slate-950 font-bold text-xs rounded-lg transition-all border border-yellow-500/20"
                        >
                          Import Savestate Slices ({libraryItems.length})
                        </button>
                      </div>
                    )}
                  </motion.div>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  {/* Left component: Preview */}
                  <div className="lg:col-span-2 flex flex-col gap-4">
                    <div className="flex justify-between items-center bg-slate-900 px-4 py-2 rounded-t-xl border-t border-x border-slate-800 font-mono">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-semibold text-slate-400 tracking-wider uppercase font-mono">Workspace View</span>
                        <div className="flex items-center bg-slate-800 p-0.5 rounded border border-slate-700 ml-2">
                          <button
                            onClick={() => setStitchWorkspaceView('preview')}
                            className={`px-2 py-1 text-[10px] font-bold rounded ${stitchWorkspaceView === 'preview' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
                          >
                            Finished Canvas
                          </button>
                          <button
                            onClick={() => setStitchWorkspaceView('interactive')}
                            className={`px-2 py-1 text-[10px] font-bold rounded flex items-center gap-1.5 ${stitchWorkspaceView === 'interactive' ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}
                            title="Di chuyển tự do mảnh và kéo góc dưới phải để chỉnh phóng to/thu nhỏ bằng chuột"
                          >
                            <Sparkles className="w-3 h-3 text-yellow-400" />
                            Drag to Move & Resize (Di chuyển & Phóng to/Thu nhỏ)
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <span className="bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] px-2 py-0.5" style={{ borderRadius: '4px' }}>
                          Canvas Size: {stitchPreviewUrl ? 'Generated' : 'Live Canvas'}
                        </span>
                      </div>
                    </div>

                    {stitchWorkspaceView === 'interactive' ? (
                      <div className="bg-[#090d16] border border-slate-800/80 rounded-b-xl min-h-[450px] p-6 overflow-auto checkerboard-bg relative select-none flex flex-col justify-center items-center">
                        <div className="text-center mb-6 max-w-xl">
                          <p className="text-xs text-indigo-400 font-semibold mb-1">
                            Bảng Tương Tác: {stitchMouseMode === 'reorder' ? 'Kéo thả đổi thứ tự' : 'Kéo thả dịch vị trí tự do'}
                          </p>
                          <p className="text-[10px] text-slate-500 leading-relaxed">
                            {stitchMouseMode === 'reorder' 
                              ? 'Kéo trực tiếp mảnh và thả lên mảnh khác để hoán đổi vị trí.' 
                              : 'Kéo trực tiếp mảnh bất kỳ để xê dịch vị trí tự do trên trục X, Y.'
                            }
                            {' '}Kéo nút <strong className="text-indigo-400">↘</strong> ở góc dưới bên phải để chỉnh thu phóng (scale).
                          </p>
                          {stitchFiles.some(f => (f.offsetX || 0) !== 0 || (f.offsetY || 0) !== 0) && (
                            <button
                              onClick={() => {
                                setStitchFiles(prev => prev.map(f => ({ ...f, offsetX: 0, offsetY: 0 })));
                              }}
                              className="mt-3 px-3 py-1 text-[10px] uppercase font-bold tracking-wider bg-indigo-600/25 hover:bg-indigo-600 text-indigo-200 hover:text-white rounded-md border border-indigo-500/40 transition-colors cursor-pointer"
                            >
                              Xoá Dịch Chuyển (Reset offsets)
                            </button>
                          )}
                        </div>
                        
                        <div 
                          className={`w-full max-w-full flex ${
                            stitchLayout === 'horizontal' ? 'flex-row' : 
                            stitchLayout === 'vertical' ? 'flex-col' : ''
                          }`}
                          style={{
                            display: stitchLayout === 'grid' ? 'grid' : 'flex',
                            gridTemplateColumns: stitchLayout === 'grid' && stitchGridMode === 'columns' ? `repeat(${stitchColumns}, minmax(0, 1fr))` : undefined,
                            gridTemplateRows: stitchLayout === 'grid' && stitchGridMode === 'rows' ? `repeat(${stitchRows}, minmax(0, 1fr))` : undefined,
                            gridAutoFlow: stitchLayout === 'grid' && stitchGridMode === 'rows' ? 'column' : undefined,
                            gap: `${stitchGap}px`,
                            justifyContent: 
                              stitchAlignment === 'start' ? 'flex-start' : 
                              stitchAlignment === 'center' ? 'center' : 'flex-end',
                            alignItems: 
                              stitchAlignment === 'start' ? 'flex-start' : 
                              stitchAlignment === 'center' ? 'center' : 'flex-end',
                            padding: `${stitchPadding}px`,
                            backgroundColor: stitchBgColor === 'transparent' ? 'transparent' : stitchBgColor,
                            borderRadius: '8px',
                          }}
                        >
                          {stitchFiles.map((file) => {
                            const currentW = file.width;
                            const currentH = file.height;
                            const currentScale = file.scale !== undefined ? file.scale : 1.0;
                            const isSelected = resizingId === file.id;
                            
                            return (
                              <div
                                key={file.id}
                                draggable={stitchMouseMode === 'reorder'}
                                onDragStart={(e) => {
                                  if (stitchMouseMode !== 'reorder') return;
                                  e.dataTransfer.setData("text/plain", file.id);
                                }}
                                onDragOver={(e) => {
                                  if (stitchMouseMode !== 'reorder') return;
                                  e.preventDefault();
                                }}
                                onDrop={(e) => {
                                  if (stitchMouseMode !== 'reorder') return;
                                  const draggedId = e.dataTransfer.getData("text/plain");
                                  if (draggedId && draggedId !== file.id) {
                                    setStitchFiles(prev => {
                                      const next = [...prev];
                                      const fromIdx = next.findIndex(f => f.id === draggedId);
                                      const toIdx = next.findIndex(f => f.id === file.id);
                                      if (fromIdx !== -1 && toIdx !== -1) {
                                        const [moved] = next.splice(fromIdx, 1);
                                        next.splice(toIdx, 0, moved);
                                      }
                                      return next;
                                    });
                                  }
                                }}
                                onMouseDown={(e) => {
                                  if (stitchMouseMode !== 'offset') return;
                                  const target = e.target as HTMLElement;
                                  if (target.closest('.resize-handle')) return;
                                  e.preventDefault();
                                  setDraggingOffsetId(file.id);
                                  setOffsetDragStart({
                                    x: e.clientX,
                                    y: e.clientY,
                                    ox: file.offsetX || 0,
                                    oy: file.offsetY || 0
                                  });
                                }}
                                className={`relative group border rounded-lg overflow-visible bg-slate-900/40 p-1.5 flex flex-col items-center justify-center ${
                                  stitchMouseMode === 'reorder' ? 'cursor-grab active:cursor-grabbing hover:border-indigo-500/50 hover:bg-slate-800/40' : 'cursor-move hover:border-emerald-500/50 hover:bg-slate-800/40'
                                } ${isSelected ? 'ring-2 ring-indigo-500 border-indigo-500 shadow-md shadow-indigo-500/20' : 'border-slate-800'}`}
                                style={{
                                  width: '140px',
                                  aspectRatio: `${currentW}/${currentH}`,
                                  transform: `translate(${file.offsetX || 0}px, ${file.offsetY || 0}px) scale(${currentScale})`,
                                  transformOrigin: 'center center',
                                }}
                              >
                                {/* Active Image with rotates and flips */}
                                <div 
                                  className={`w-full h-full relative overflow-hidden rounded bg-slate-950/60 transition-all ${
                                    isSelected ? 'ring-2 ring-indigo-500 shadow-lg shadow-indigo-500/30' : ''
                                  }`}
                                  style={{
                                    transform: `rotate(${file.rotation}deg) scaleX(${file.flipH ? -1 : 1}) scaleY(${file.flipV ? -1 : 1})`,
                                  }}
                                >
                                  <img 
                                    src={file.previewUrl} 
                                    className="w-full h-full object-contain pointer-events-none" 
                                    alt={file.name} 
                                  />
                                </div>
                                
                                {/* Info badge / Label overlay */}
                                <div className="absolute top-2 left-2 right-2 bg-slate-950/90 backdrop-blur-sm border border-slate-800 px-2 py-1 rounded text-[9px] text-slate-300 font-mono flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                  <span className="truncate max-w-[50px]">{file.name}</span>
                                  <span className="text-indigo-400 font-bold">x{(file.scale || 1.0).toFixed(2)}</span>
                                </div>

                                {/* Drag-to-Resize Handle at the bottom right */}
                                <div
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setResizingId(file.id);
                                    setResizeStart({
                                      x: e.clientX,
                                      y: e.clientY,
                                      scale: currentScale
                                    });
                                  }}
                                  className="absolute -bottom-1 -right-1 w-5 h-5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full flex items-center justify-center cursor-se-resize shadow shadow-black hover:scale-110 active:scale-95 transition-all z-20 resize-handle"
                                  title="Resizing Grip - Drag to scale"
                                >
                                  <span className="text-[10px] font-bold select-none leading-none">↘</span>
                                </div>

                                {/* Quick individual scale adjustment display */}
                                <div className="absolute bottom-1 left-1.5 text-[8px] font-mono text-slate-400 font-semibold bg-slate-950/80 px-1 py-0.5 rounded pointer-events-none">
                                  {Math.round(currentW * currentScale)}x{Math.round(currentH * currentScale)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-[#090d16] border border-slate-800/80 rounded-b-xl min-h-[350px] p-6 flex items-center justify-center overflow-auto checkerboard-bg relative select-none">
                        {stitchPreviewUrl ? (
                          <div className="relative max-w-full max-h-[500px] shadow-2xl rounded">
                            <img 
                              src={stitchPreviewUrl} 
                              alt="Stitched compositor preview" 
                              className="max-h-[500px] object-contain rounded border border-slate-800 shadow shadow-black"
                            />
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-2 text-slate-500">
                            <RefreshCw className="w-8 h-8 animate-spin" />
                            <span className="text-xs">Preparing compositor preview...</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right Component: Quick Rearrangement / Details */}
                  <div className="space-y-6">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow">
                      <h3 className="text-sm font-semibold tracking-wider uppercase text-slate-400 mb-4 font-mono">Piece Layout Order</h3>
                      <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                        To re-arrange layout sequence, use the arrows. Drag and drop uploads sequence from left-to-right (horizontal) or top-to-bottom (vertical).
                      </p>
                      
                      <div className="space-y-2 max-h-[320px] overflow-y-auto custom-scrollbar pr-1">
                        {stitchFiles.map((item, idx) => (
                          <div key={item.id} className="bg-slate-850 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between gap-3 hover:border-slate-700 transition-colors">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs font-mono font-bold text-slate-600 bg-slate-900 w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                                {idx + 1}
                              </span>
                              <div className="w-8 h-8 shrink-0 rounded bg-slate-900 border border-slate-850 overflow-hidden checkerboard-bg flex items-center justify-center">
                                <img src={item.previewUrl} alt="" className="max-w-full max-h-full object-contain" />
                              </div>
                              <span className="text-xs font-medium text-slate-300 truncate" title={item.name}>
                                {item.name}
                              </span>
                            </div>
                            
                            <div className="flex items-center gap-1 shrink-0">
                              <button 
                                onClick={() => moveStitchFile(idx, 'up')}
                                disabled={idx === 0}
                                className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 disabled:opacity-20"
                                title="Move Left/Up"
                              >
                                <ArrowUp className="w-3.5 h-3.5" />
                              </button>
                              <button 
                                onClick={() => moveStitchFile(idx, 'down')}
                                disabled={idx === stitchFiles.length - 1}
                                className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 disabled:opacity-20"
                                title="Move Right/Down"
                              >
                                <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-5 text-center flex flex-col items-center">
                      <Wand2 className="w-5 h-5 text-indigo-400 mb-2" />
                      <h4 className="text-xs font-mono font-bold text-slate-300 uppercase mb-1">Interactive Features</h4>
                      <p className="text-[11px] text-slate-500 leading-relaxed">
                        Need fine-grained transforms like rotating individual slices or flipping? Use the controls in the Image Stitcher Sidebar panel.
                      </p>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </main>
        )}

        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 20, x: '-50%' }}
              animate={{ opacity: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, y: -10, x: '-50%' }}
              className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-red-900/90 text-red-100 border border-red-700 px-6 py-3 rounded-full flex items-center gap-3 shadow-lg z-50 text-sm font-medium"
            >
              <X className="w-4 h-4 cursor-pointer" onClick={() => setError(null)} />
              {error}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Library Slide-over Panel */}
      <AnimatePresence>
        {showLibrary && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowLibrary(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 transition-opacity"
            />
            {/* Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-800 shadow-2xl z-50 flex flex-col"
            >
              <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-800/50">
                <div className="flex items-center gap-2">
                  <Library className="w-5 h-5 text-indigo-400" />
                  <h2 className="font-bold text-lg">My Library</h2>
                  <span className="bg-indigo-500/20 text-indigo-300 text-xs px-2 py-0.5 rounded-full font-bold ml-2">
                    {libraryItems.length}
                  </span>
                </div>
                <button
                  onClick={() => setShowLibrary(false)}
                  className="p-1.5 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scrollbar">
                {libraryItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3">
                    <Archive className="w-12 h-12 opacity-20" />
                    <p className="text-sm">Your library is empty.</p>
                  </div>
                ) : (
                  libraryItems.map(item => (
                    <div key={item.id} className="flex gap-3 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50 group">
                      <div className="w-20 h-20 bg-black/50 rounded pointer-events-none flex items-center justify-center shrink-0 checkerboard-bg">
                         <img src={item.previewUrl} alt={item.name} className="max-w-full max-h-full object-contain" />
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col justify-center">
                        <input
                           type="text"
                           value={item.name}
                           onChange={(e) => {
                              setLibraryItems(prev => prev.map(i => i.id === item.id ? { ...i, name: e.target.value } : i));
                           }}
                           className="w-full bg-transparent text-sm font-medium text-slate-200 outline-none border-b border-transparent focus:border-indigo-500 mb-1 truncate"
                        />
                        <span className="text-[10px] text-slate-500 font-mono tracking-widest uppercase mb-2">{(item.blob.size / 1024).toFixed(1)} KB</span>
                        <div className="flex gap-2">
                          <a 
                            href={item.previewUrl} 
                            download={item.name}
                            className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
                          >
                            <Download className="w-3 h-3" /> Save
                          </a>
                          <button 
                            onClick={() => {
                               URL.revokeObjectURL(item.previewUrl);
                               setLibraryItems(prev => prev.filter(i => i.id !== item.id));
                            }}
                            className="text-xs font-semibold text-red-400 hover:text-red-300 transition-colors flex items-center gap-1 ml-auto"
                          >
                            <Trash2 className="w-3 h-3" /> Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {libraryItems.length > 0 && (
                <div className="p-4 border-t border-slate-800 bg-slate-900 flex flex-col gap-3">
                  <button
                    onClick={async () => {
                        const zip = new JSZip();
                        const folderName = `library_export`;
                        const imgFolder = zip.folder(folderName);
                        libraryItems.forEach(item => {
                           let fileName = item.name.trim();
                           if (!fileName.toLowerCase().endsWith('.png')) fileName += '.png';
                           imgFolder!.file(fileName, item.blob);
                        });
                        const zipBlob = await zip.generateAsync({ type: 'blob' });
                        const downloadUrl = URL.createObjectURL(zipBlob);
                        const tempLink = document.createElement('a');
                        tempLink.href = downloadUrl;
                        tempLink.download = `${folderName}.zip`;
                        document.body.appendChild(tempLink);
                        tempLink.click();
                        document.body.removeChild(tempLink);
                        URL.revokeObjectURL(downloadUrl);
                    }}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded font-bold text-sm tracking-wide transition-all shadow-lg flex items-center justify-center gap-2"
                  >
                    <Download className="w-4 h-4" /> Download All as ZIP
                  </button>
                  <button
                     onClick={() => {
                        libraryItems.forEach(item => URL.revokeObjectURL(item.previewUrl));
                        setLibraryItems([]);
                     }}
                     className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-red-400 hover:text-red-300 border border-red-500/20 rounded font-bold text-xs transition-colors flex justify-center items-center gap-1.5"
                  >
                     <Trash2 className="w-3.5 h-3.5" /> Clear Library
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Bottom Status Bar */}
      <footer className="h-8 bg-[#0f172a] border-t border-slate-800 flex items-center px-4 justify-between text-[10px] text-slate-500 shrink-0 font-medium tracking-wide uppercase">
        <div className="flex items-center gap-6">
           {currentTool === 'splitter' ? (
             <span>Pieces: {totalSlices}</span>
           ) : (
             <span>Images: {bgFiles.length} | Done: {bgFiles.filter(f=>f.status==='done').length}</span>
           )}
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Ready
          </span>
          <span>Local Browser Execution</span>
        </div>
      </footer>
      
      {/* CSS for checkerboard background to visualize transparency */}
      <style>{`
        .checkerboard-bg {
          background-image: 
            linear-gradient(45deg, #1e293b 25%, transparent 25%), 
            linear-gradient(-45deg, #1e293b 25%, transparent 25%), 
            linear-gradient(45deg, transparent 75%, #1e293b 75%), 
            linear-gradient(-45deg, transparent 75%, #1e293b 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
      `}</style>
    </div>
  );
}

