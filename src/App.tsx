/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { UploadCloud, Download, Image as ImageIcon, CheckCircle2, RefreshCw, X, Grid3X3, Layers, Scissors, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { removeBackgroundV2 } from './lib/bgRemoval';

type ToolType = 'splitter' | 'bg-remover';

type BgFile = {
  id: string;
  file: File;
  previewUrl: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  resultBlob?: Blob;
  resultUrl?: string;
  errorMsg?: string;
};

export default function App() {
  const [currentTool, setCurrentTool] = useState<ToolType>('splitter');
  
  // -- Splitter State --
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [downloadBaseName, setDownloadBaseName] = useState<string>('');
  
  const [columnsStr, setColumnsStr] = useState<string>("4");
  const [rowsStr, setRowsStr] = useState<string>("3");
  const [vLinesPerRow, setVLinesPerRow] = useState<number[][]>([
    [0.25, 0.5, 0.75],
    [0.25, 0.5, 0.75],
    [0.25, 0.5, 0.75]
  ]);
  const [hLines, setHLines] = useState<number[]>([1/3, 2/3]);

  const getTotalSlices = () => {
    let total = 0;
    for (let i = 0; i < hLines.length + 1; i++) {
        total += (vLinesPerRow[i]?.length || 0) + 1;
    }
    return total;
  };
  const totalSlices = getTotalSlices();

  const [previewMode, setPreviewMode] = useState<'grid' | 'exploded'>('grid');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);

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
    if (!file.type.startsWith('image/')) {
      setError('Please select a valid image file (JPEG, PNG, WebP).');
      return;
    }
    setImageFile(file);
    setDownloadBaseName(file.name.substring(0, file.name.lastIndexOf('.')) || 'image');
    const url = URL.createObjectURL(file);
    setImagePreviewUrl(url);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

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
      let v: number[] = [];
      let step = 1 / c;
      for (let i = step; i < 0.9999; i += step) v.push(i);
      setVLinesPerRow(Array.from({ length: h.length + 1 }, () => [...v]));
    } else {
      setVLinesPerRow(Array.from({ length: h.length + 1 }, () => []));
    }
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
      [0.25, 0.5, 0.75],
      [0.25, 0.5, 0.75],
      [0.25, 0.5, 0.75]
    ]);
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

      return { img, ctx, canvas };
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
      for (let row = 0; row < hPlacements.length - 1; row++) {
        const rowVLines = vLinesPerRow[row] || [];
        const vPlacements = [0, ...[...rowVLines].sort((a,b)=>a-b), 1];

        for (let col = 0; col < vPlacements.length - 1; col++) {
           const slicePromise = new Promise<void>((resolve, reject) => {
               const startX = vPlacements[col] * img.width;
               const endX = vPlacements[col + 1] * img.width;
               const startY = hPlacements[row] * img.height;
               const endY = hPlacements[row + 1] * img.height;
               
               const sliceWidth = Math.max(1, Math.round(endX - startX));
               const sliceHeight = Math.max(1, Math.round(endY - startY));

               canvas.width = sliceWidth;
               canvas.height = sliceHeight;
               ctx.clearRect(0, 0, sliceWidth, sliceHeight);
               ctx.drawImage(img, Math.round(startX), Math.round(startY), sliceWidth, sliceHeight, 0, 0, sliceWidth, sliceHeight);

               canvas.toBlob((blob) => {
                 if (blob) {
                   const indexStr = index.toString().padStart(2, '0');
                   const fileName = `${baseName}_slice_${indexStr}.png`;
                   
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
               }, imageFile.type === 'image/jpeg' ? 'image/jpeg' : 'image/png');
           });
           
           if (!downloadAsZip) {
               await slicePromise; // await sequentially to avoid browser blocking multiple rapid downloads
               await new Promise(r => setTimeout(r, 50)); 
           } else {
               slicePromises.push(slicePromise);
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

          {currentTool === 'splitter' && imagePreviewUrl && (
            <>
              <button 
                onClick={handleReset}
                className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm font-medium transition-colors border border-slate-600"
              >
                Start Over
              </button>
              <button 
                onClick={splitAndDownload}
                disabled={isProcessing || totalSlices <= 1}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-2"
              >
                {isProcessing ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Processing...</>
                ) : (
                  <>Download All ({totalSlices})</>
                )}
              </button>
            </>
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
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        
        {/* === SPLITTER MODE UI === */}
        {currentTool === 'splitter' && (
          <>
            {/* Sidebar Controls */}
            {imagePreviewUrl && (
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

                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Grid Configuration</label>
                  <div className="space-y-6">
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium">Columns (Decimal Ok)</span>
                      </div>
                      <input
                        id="columns"
                        type="number"
                        step="0.01"
                        min="0.1"
                        max="50"
                        value={columnsStr}
                        onChange={(e) => {
                          setColumnsStr(e.target.value);
                          updateGridLines(e.target.value, rowsStr);
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium">Rows (Decimal Ok)</span>
                      </div>
                      <input
                        id="rows"
                        type="number"
                        step="0.01"
                        min="0.1"
                        max="50"
                        value={rowsStr}
                        onChange={(e) => {
                          setRowsStr(e.target.value);
                          updateGridLines(columnsStr, e.target.value);
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Preview Mode</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={() => setPreviewMode('grid')}
                      className={`p-3 rounded border text-xs font-semibold transition-colors ${previewMode === 'grid' ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-400'}`}
                    >
                      Grid Lines
                    </button>
                    <button 
                      onClick={() => setPreviewMode('exploded')}
                      className={`p-3 rounded border text-xs font-semibold transition-colors ${previewMode === 'exploded' ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-400'}`}
                    >
                      Split Pieces
                    </button>
                  </div>
                </div>

                <div className="mt-auto">
                  <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                    <h4 className="text-xs font-bold uppercase text-slate-500 mb-2 italic">File Info</h4>
                    {imageSize && (
                      <div className="flex justify-between text-xs py-1">
                        <span className="text-slate-400">Dimensions:</span>
                        <span>{imageSize.width} x {imageSize.height} px</span>
                      </div>
                    )}
                    {imageFile && (
                      <div className="flex justify-between text-xs py-1">
                        <span className="text-slate-400">Format:</span>
                        <span className="uppercase">{imageFile.type.split('/')[1] || 'Unknown'}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs py-1">
                      <span className="text-slate-400">Slices:</span>
                      <span>{totalSlices}</span>
                    </div>
                  </div>
                </div>
              </aside>
            )}

            {/* Main Workspace */}
            <main className="flex-1 bg-[#0f172a] p-8 md:p-12 flex items-center justify-center relative overflow-hidden">
              {!imagePreviewUrl ? (
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
              ) : (
                <>
                  {/* Image Canvas Area */}
                  {previewMode === 'grid' ? (
                    <div className="relative shadow-2xl rounded shadow-black/50 group max-w-full max-h-full flex overflow-hidden bg-slate-900 checkerboard-bg" ref={imageElementRef}>
                      <img
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
                               
                               return rowVLines.map((v, cIdx) => (
                                 <div
                                   key={`v-${rIdx}-${cIdx}`}
                                   className="absolute w-4 -ml-2 cursor-col-resize flex justify-center group/line z-10"
                                   style={{ 
                                      left: `${v * 100}%`,
                                      top: `${startH * 100}%`,
                                      height: `${(endH - startH) * 100}%`
                                   }}
                                   onMouseDown={(e) => {
                                     e.preventDefault();
                                     const startX = e.clientX;
                                     const startVal = rowVLines[cIdx];
                                     const rect = imageElementRef.current!.getBoundingClientRect();
                                     const handleMouseMove = (me: MouseEvent) => {
                                       const delta = me.clientX - startX;
                                       const newVal = Math.max(0, Math.min(1, startVal + delta / rect.width));
                                       setVLinesPerRow(prev => {
                                           const next = [...prev];
                                           const nextRow = [...(next[rIdx] || [])];
                                           nextRow[cIdx] = newVal;
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
                                   <div className="w-[1.5px] h-full bg-blue-500/80 group-hover/line:bg-blue-400 group-hover/line:w-[3px] transition-all shadow-[0_0_3px_rgba(0,0,0,0.5)]"></div>
                                 </div>
                               ));
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
                                const rect = imageElementRef.current!.getBoundingClientRect();
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
                  ) : (
                    <div 
                      className="flex justify-center items-center h-[calc(100vh-12rem)] max-w-full w-full p-4"
                    >
                      <div 
                        className="flex flex-col gap-3 p-2 rounded-xl bg-[#1e293b]/80 shadow-2xl overflow-hidden w-full h-full"
                        style={{
                           aspectRatio: imageSize ? `${imageSize.width} / ${imageSize.height}` : 'auto',
                           maxHeight: '100%',
                           maxWidth: '100%',
                        }}
                      >
                         {(() => {
                            let hP = [0, ...[...hLines].sort((a,b)=>a-b), 1];
                            let sliceIndex = 0;
                            return hP.slice(0, -1).map((startH, rIdx) => {
                                const endH = hP[rIdx + 1];
                                const rowHeightPercent = (endH - startH) * 100;
                                const rowVLines = vLinesPerRow[rIdx] || [];
                                let vP = [0, ...[...rowVLines].sort((a,b)=>a-b), 1];
                                
                                return (
                                    <div key={rIdx} className="flex gap-3 w-full" style={{ height: `${rowHeightPercent}%` }}>
                                        {vP.slice(0, -1).map((startV, cIdx) => {
                                            const endV = vP[cIdx + 1];
                                            const colWidthPercent = (endV - startV) * 100;
                                            
                                            const bgPosX = vP.length > 2 ? (startV / (1 - (endV - startV))) * 100 : 0;
                                            const bgPosY = hP.length > 2 ? (startH / (1 - (endH - startH))) * 100 : 0;
                                            const bgSizeX = 1 / (endV - startV) * 100;
                                            const bgSizeY = 1 / (endH - startH) * 100;
                                            
                                            const currIndex = sliceIndex++;
                                            
                                            return (
                                              <div 
                                                key={cIdx} 
                                                className="relative overflow-hidden rounded bg-[#0f172a] checkerboard-bg transform transition-transform hover:scale-[1.02] shadow-md border border-slate-700/50 hover:border-indigo-500 hover:shadow-indigo-500/20"
                                                style={{
                                                  width: `${colWidthPercent}%`,
                                                  backgroundImage: `url(${imagePreviewUrl})`,
                                                  backgroundSize: `${isFinite(bgSizeX) ? bgSizeX : 0}% ${isFinite(bgSizeY) ? bgSizeY : 0}%`,
                                                  backgroundPosition: `${isFinite(bgPosX) ? bgPosX : 0}% ${isFinite(bgPosY) ? bgPosY : 0}%`
                                                }}
                                              >
                                                <span className="absolute top-1 left-1 text-[10px] bg-black/70 px-1.5 py-0.5 rounded text-white shadow-sm pointer-events-none backdrop-blur-sm">
                                                  {currIndex + 1}
                                                </span>
                                              </div>
                                            );
                                        })}
                                    </div>
                                )
                            });
                         })()}
                      </div>
                    </div>
                  )}
                </>
              )}
            </main>
          </>
        )}


        {/* === BACKGROUND REMOVER UI === */}
        {currentTool === 'bg-remover' && (
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

