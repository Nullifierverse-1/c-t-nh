/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { UploadCloud, Download, Image as ImageIcon, CheckCircle2, RefreshCw, X, Grid3X3, Layers, Scissors, Trash2, RotateCcw, RotateCw, ZoomIn, ZoomOut, FlipHorizontal, FlipVertical, Sparkles, Wand2, Maximize2, Archive, Library } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { removeBackgroundV2 } from './lib/bgRemoval';

type ToolType = 'splitter' | 'bg-remover' | 'ai-expand';

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
  const [hLines, setHLines] = useState<number[]>([1/3, 2/3]);
  const [selectedLine, setSelectedLine] = useState<{ rIdx: number, cIdx: number } | null>(null);

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
    const c = parseFloat(cStr);
    const r = parseFloat(rStr);
    
    let h: number[] = [];
    if (r > 0) {
      let step = 1 / r;
      for (let i = step; i < 0.9999; i += step) h.push(i);
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
    setHLines([1/3, 2/3]);
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
        setColumnsStr(data.columns.toString());
        setRowsStr(data.rows.toString());
        
        let c = data.columns;
        let r = data.rows;
        
        let h: number[] = [];
        if (r > 0) {
          let step = 1 / r;
          for (let i = step; i < 0.9999; i += step) h.push(i);
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
      const hPlacements = [0, ...[...hLines].sort((a,b)=>a-b), 1];

      let index = 1;
      const W = img.width;
      const H = img.height;

      const slicesToDownload = selectedPieces.size > 0 ? selectedPieces : null;
      
      for (let row = 0; row < hPlacements.length - 1; row++) {
        const rowVLines = vLinesPerRow[row] || [];
        const sortedLines = [...rowVLines].sort((a,b)=>a.pos-b.pos);
        
        const topY = hPlacements[row] * H;
        const bottomY = hPlacements[row + 1] * H;
        const centerY = (topY + bottomY) / 2;
        
        const getXAtY = (lineInfo: {pos: number, angle: number} | 'left' | 'right', y: number) => {
            if (lineInfo === 'left') return 0;
            if (lineInfo === 'right') return W;
            const cx = lineInfo.pos * W;
            const rad = lineInfo.angle * Math.PI / 180;
            return cx - (y - centerY) * Math.tan(rad);
        };

        for (let col = 0; col <= sortedLines.length; col++) {
           const currIndexZeroBased = index - 1;
           const shouldDownload = !slicesToDownload || slicesToDownload.has(currIndexZeroBased);
           
           if (shouldDownload) {
             const leftLine = col === 0 ? 'left' : sortedLines[col - 1];
             const rightLine = col === sortedLines.length ? 'right' : sortedLines[col];
             
             const tlX = Math.max(0, Math.min(W, getXAtY(leftLine, topY)));
             const blX = Math.max(0, Math.min(W, getXAtY(leftLine, bottomY)));
             const trX = Math.max(0, Math.min(W, getXAtY(rightLine, topY)));
             const brX = Math.max(0, Math.min(W, getXAtY(rightLine, bottomY)));
             
             const minX = Math.max(0, Math.floor(Math.min(tlX, blX, trX, brX)));
             const maxX = Math.min(W, Math.ceil(Math.max(tlX, blX, trX, brX)));
             
             const slicePromise = new Promise<void>((resolve, reject) => {
                 const sliceW = Math.round(maxX - minX);
                 const sliceH = Math.round(bottomY - topY);
                 
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
                 ctx.moveTo(Math.round(tlX - minX), 0);
                 ctx.lineTo(Math.round(trX - minX), 0);
                 ctx.lineTo(Math.round(brX - minX), sliceH);
                 ctx.lineTo(Math.round(blX - minX), sliceH);
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
      const hPlacements = [0, ...[...hLines].sort((a,b)=>a-b), 1];
      
      let index = 1;
      const W = img.width;
      const H = img.height;
      const slicesToSave = selectedPieces.size > 0 ? selectedPieces : null;
      
      for (let row = 0; row < hPlacements.length - 1; row++) {
        const rowVLines = vLinesPerRow[row] || [];
        const sortedLines = [...rowVLines].sort((a,b)=>a.pos-b.pos);
        
        const topY = hPlacements[row] * H;
        const bottomY = hPlacements[row + 1] * H;
        const centerY = (topY + bottomY) / 2;
        
        const getXAtY = (lineInfo: {pos: number, angle: number} | 'left' | 'right', y: number) => {
            if (lineInfo === 'left') return 0;
            if (lineInfo === 'right') return W;
            const cx = lineInfo.pos * W;
            const rad = lineInfo.angle * Math.PI / 180;
            return cx - (y - centerY) * Math.tan(rad);
        };

        for (let col = 0; col <= sortedLines.length; col++) {
           const currIndexZeroBased = index - 1;
           const shouldSave = !slicesToSave || slicesToSave.has(currIndexZeroBased);
           
           if (shouldSave) {
             const leftLine = col === 0 ? 'left' : sortedLines[col - 1];
             const rightLine = col === sortedLines.length ? 'right' : sortedLines[col];
             
             const tlX = Math.max(0, Math.min(W, getXAtY(leftLine, topY)));
             const blX = Math.max(0, Math.min(W, getXAtY(leftLine, bottomY)));
             const trX = Math.max(0, Math.min(W, getXAtY(rightLine, topY)));
             const brX = Math.max(0, Math.min(W, getXAtY(rightLine, bottomY)));
             
             const minX = Math.max(0, Math.floor(Math.min(tlX, blX, trX, brX)));
             const maxX = Math.min(W, Math.ceil(Math.max(tlX, blX, trX, brX)));
             
             const slicePromise = new Promise<void>((resolve, reject) => {
                 const sliceW = Math.round(maxX - minX);
                 const sliceH = Math.round(bottomY - topY);
                 
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
                 ctx.moveTo(Math.round(tlX - minX), 0);
                 ctx.lineTo(Math.round(trX - minX), 0);
                 ctx.lineTo(Math.round(brX - minX), sliceH);
                 ctx.lineTo(Math.round(blX - minX), sliceH);
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
      <header className="h-14 bg-[#1e293b] border-b border-slate-700 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center">
              <Scissors className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight hidden sm:block">Slice&nbsp;&amp;&nbsp;Dice</span>
          </div>
          
          {/* Tool Switcher */}
          <div className="flex items-center bg-slate-800 p-1 rounded-lg">
            <button 
              onClick={() => setCurrentTool('splitter')} 
              className={`px-3 py-1.5 rounded text-sm font-medium transition-all ${currentTool === 'splitter' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}`}
            >
              Image Splitter
            </button>
            <button 
              onClick={() => setCurrentTool('bg-remover')} 
              className={`px-3 py-1.5 rounded text-sm font-medium transition-all flex items-center gap-1.5 ${currentTool === 'bg-remover' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}`}
            >
              Background Remover
              <span className="bg-indigo-500/20 text-indigo-300 text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wider font-bold">New</span>
            </button>
            <button 
              onClick={() => setCurrentTool('ai-expand')} 
              className={`px-3 py-1.5 rounded text-sm font-medium transition-all flex items-center gap-1.5 ${currentTool === 'ai-expand' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}`}
            >
              AI Expand
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Global 'Save as ZIP' Toggle */}
          {(currentTool === 'splitter' && imagePreviewUrl) || (currentTool === 'bg-remover' && bgFiles.length > 0) ? (
            <label className="flex items-center gap-2 text-sm text-slate-300 font-medium cursor-pointer bg-slate-800/50 px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 transition-colors">
              <input 
                type="checkbox" 
                checked={downloadAsZip} 
                onChange={(e) => setDownloadAsZip(e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-indigo-500 focus:ring-indigo-500/50"
              />
              Save as ZIP
            </label>
          ) : null}

          {currentTool === 'ai-expand' && imagePreviewUrl && (
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setExpandOffsets({top: 0, bottom: 0, left: 0, right: 0})}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors border border-slate-600"
              >
                Reset Handles
              </button>
              <div className="w-px h-6 bg-slate-700 mx-1"></div>
              <button
                onClick={handleAIExpand}
                disabled={isExpandingAI || isProcessing}
                className="px-4 py-1.5 bg-pink-600 hover:bg-pink-500 rounded text-sm font-bold transition-all shadow-lg shadow-pink-500/20 disabled:opacity-50 flex items-center gap-2"
              >
                {isExpandingAI ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Generate Expansion
              </button>
            </div>
          )}

          {currentTool === 'splitter' && imagePreviewUrl && (
            <div className="flex items-center gap-2">
              <button 
                onClick={handleReset}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors border border-slate-600"
                title="Start over with a new image"
              >
                Reset
              </button>

              <div className="w-px h-6 bg-slate-700 mx-1"></div>

              <button
                onClick={handleUpscale}
                disabled={isUpscaling || isProcessing || isSharpening}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs font-medium transition-all border border-slate-700 flex items-center gap-1.5 shadow-sm"
                title="Upscale image resolution by 2x"
              >
                {isUpscaling ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ZoomIn className="w-3.5 h-3.5" />}
                Upscale 2x
              </button>

              <button 
                onClick={splitAndSaveToLibrary}
                disabled={isProcessing || isUpscaling}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs font-medium transition-all border border-slate-700 flex items-center gap-1.5 shadow-sm text-yellow-400 border-yellow-400/30"
                title="Save the selected pieces to Library"
              >
                <Archive className="w-3.5 h-3.5" />
                To Library
              </button>

              <button 
                onClick={downloadFull}
                disabled={isProcessing || isUpscaling}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs font-medium transition-all border border-slate-700 flex items-center gap-1.5 shadow-sm"
                title="Download the current full image (with transforms applied)"
              >
                <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                Save Full
              </button>

              <button 
                onClick={splitAndDownload}
                disabled={isProcessing || isUpscaling}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-bold transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
              >
                {isProcessing ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> ...</>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    {selectedPieces.size > 0 ? `Save Selected (${selectedPieces.size})` : `Download Grid (${totalSlices})`}
                  </>
                )}
              </button>
            </div>
          )}

          {currentTool === 'bg-remover' && bgFiles.length > 0 && (
            <>
               <button 
                 onClick={clearBgFiles}
                 className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm font-medium transition-colors border border-slate-600"
               >
                 Clear All
               </button>
               {bgFiles.some(f => f.status === 'done') && (
                 <button 
                   onClick={downloadAllBg}
                   disabled={isProcessing}
                   className="px-4 py-1.5 bg-green-600 hover:bg-green-500 rounded text-sm font-medium transition-colors shadow-lg shadow-green-500/20 disabled:opacity-50 flex items-center gap-2"
                 >
                   {isProcessing ? <><RefreshCw className="w-4 h-4 animate-spin" /> Saving...</> : <>Download All</>}
                 </button>
               )}
            </>
          )}

          <div className="w-px h-6 bg-slate-700 mx-2"></div>
          
          <button
            onClick={() => setShowLibrary(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm font-medium text-slate-300 border border-slate-700 transition-colors relative"
          >
            <Library className="w-4 h-4" />
            Library
            {libraryItems.length > 0 && (
              <span className="absolute -top-2 -right-2 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {libraryItems.length}
              </span>
            )}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        
        {/* === SIDEBARS === */}
        {imagePreviewUrl && (
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
                        Column Line Angle
                        <button onClick={() => setSelectedLine(null)} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
                      </label>
                      <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-md">
                        <input
                          type="range"
                          min="-75"
                          max="75"
                          value={vLinesPerRow[selectedLine.rIdx][selectedLine.cIdx].angle}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setVLinesPerRow(prev => {
                              const next = [...prev];
                              const nextRow = [...(next[selectedLine.rIdx] || [])];
                              nextRow[selectedLine.cIdx] = { ...nextRow[selectedLine.cIdx], angle: val };
                              next[selectedLine.rIdx] = nextRow;
                              return next;
                            });
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
                        step="0.1"
                        value={columnsStr}
                        onChange={(e) => {
                          setColumnsStr(e.target.value);
                          updateGridLines(e.target.value, rowsStr);
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <span className="text-sm font-medium mb-1 block">Rows</span>
                      <input
                        type="number"
                        step="0.1"
                        value={rowsStr}
                        onChange={(e) => {
                          setRowsStr(e.target.value);
                          updateGridLines(columnsStr, e.target.value);
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
          </>
        )}

        {/* === MAIN WORKSPACE === */}
        {currentTool !== 'bg-remover' ? (
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
                                 const hP = [0, ...[...hLines].sort((a,b)=>a-b), 1];
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
                                         const isSelected = selectedLine?.rIdx === rIdx && selectedLine?.cIdx === cIdx;
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
                                          setSelectedLine({ rIdx, cIdx });
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
                              
                              {hLines.map((h, i) => (
                                <div
                                  key={`h-${i}`}
                                  className="absolute left-0 right-0 h-4 -mt-2 cursor-row-resize flex flex-col justify-center group/line z-10"
                                  style={{ top: `${h * 100}%` }}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    const startY = e.clientY;
                                    const startVal = hLines[i];
                                    const rect = imageElementRef.current?.getBoundingClientRect();
                                    if (!rect) return;
                                    const handleMouseMove = (me: MouseEvent) => {
                                      const delta = me.clientY - startY;
                                      const newVal = Math.max(0, Math.min(1, startVal + delta / rect.height));
                                      setHLines(prev => {
                                          const next = [...prev];
                                          next[i] = newVal;
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
                                  <div className="h-[1.5px] w-full bg-green-500/80 group-hover/line:bg-green-400 group-hover/line:h-[3px] transition-all shadow-[0_0_3px_rgba(0,0,0,0.5)]"></div>
                                </div>
                              ))}
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
                                const hP = [0, ...[...hLines].sort((a,b)=>a-b), 1];
                                let sliceIndex = 0;
                                const W = imageSize.width;
                                const H = imageSize.height;
    
                                return hP.slice(0, -1).map((startH, rIdx) => {
                                    const endH = hP[rIdx + 1];
                                    const topY = startH * H;
                                    const bottomY = endH * H;
                                    const centerY = (topY + bottomY) / 2;
                                    
                                    const rowVLines = vLinesPerRow[rIdx] || [];
                                    const sortedLines = [...rowVLines].sort((a,b)=>a.pos-b.pos);
                                    
                                    const getXAtY = (lineInfo: {pos: number, angle: number} | 'left' | 'right', y: number) => {
                                        if (lineInfo === 'left') return 0;
                                        if (lineInfo === 'right') return W;
                                        const cx = lineInfo.pos * W;
                                        const rad = lineInfo.angle * Math.PI / 180;
                                        return cx - (y - centerY) * Math.tan(rad);
                                    };
    
                                    return sortedLines.concat('right' as any).map((rightLine, cIdx) => {
                                        const leftLine = cIdx === 0 ? 'left' : sortedLines[cIdx - 1];
                                        
                                        const tlX = Math.max(0, Math.min(W, getXAtY(leftLine as any, topY)));
                                        const blX = Math.max(0, Math.min(W, getXAtY(leftLine as any, bottomY)));
                                        const trX = Math.max(0, Math.min(W, getXAtY(rightLine as any, topY)));
                                        const brX = Math.max(0, Math.min(W, getXAtY(rightLine as any, bottomY)));
                                        
                                        const minX = Math.floor(Math.min(tlX, blX, trX, brX));
                                        const maxX = Math.ceil(Math.max(tlX, blX, trX, brX));
                                        
                                        const sliceW = Math.max(1, maxX - minX);
                                        const sliceH = Math.max(1, bottomY - topY);
                                        
                                        const currIndex = sliceIndex++;
                                        const transformData = pieceTransforms[currIndex] || { rotation: 0, flipH: false, flipV: false };
                                        const isSelected = selectedPieces.has(currIndex);
                                        
                                        const explodeX = (cIdx - sortedLines.length / 2) * 12;
                                        const explodeY = (rIdx - (hP.length - 1) / 2) * 12;
    
                                        const pTL = { x: ((tlX - minX) / sliceW) * 100, y: 0 };
                                        const pTR = { x: ((trX - minX) / sliceW) * 100, y: 0 };
                                        const pBR = { x: ((brX - minX) / sliceW) * 100, y: 100 };
                                        const pBL = { x: ((blX - minX) / sliceW) * 100, y: 100 };
                                        
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
              ) : (
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

