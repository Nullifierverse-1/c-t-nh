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
  const [columns, setColumns] = useState<number>(4);
  const [rows, setRows] = useState<number>(3);
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

  const handleReset = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(null);
    setImageFile(null);
    setImageSize(null);
    setError(null);
    setColumns(4);
    setRows(3);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const getCanvasContext = async () => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image for processing'));
        img.src = imagePreviewUrl!;
      });

      const pieceWidth = Math.floor(img.width / columns);
      const pieceHeight = Math.floor(img.height / rows);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) throw new Error('Could not get 2d context from canvas');

      canvas.width = pieceWidth;
      canvas.height = pieceHeight;

      return { img, pieceWidth, pieceHeight, ctx, canvas };
  };

  const splitAndDownload = async () => {
    if (!imageFile || !imagePreviewUrl) return;
    setIsProcessing(true);
    setError(null);

    try {
      const { img, pieceWidth, pieceHeight, ctx, canvas } = await getCanvasContext();
      
      const zip = new JSZip();
      const originalName = imageFile.name.substring(0, imageFile.name.lastIndexOf('.')) || 'image';
      const folderName = `${originalName}_split_${columns}x${rows}`;
      const imgFolder = zip.folder(folderName);
      
      const slicePromises: Promise<void>[] = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
           const slicePromise = new Promise<void>((resolve, reject) => {
               ctx.clearRect(0, 0, pieceWidth, pieceHeight);
               const sx = col * pieceWidth;
               const sy = row * pieceHeight;
               ctx.drawImage(img, sx, sy, pieceWidth, pieceHeight, 0, 0, pieceWidth, pieceHeight);

               canvas.toBlob((blob) => {
                 if (blob) {
                   const index = (row * columns) + col + 1;
                   const indexStr = index.toString().padStart(2, '0');
                   imgFolder!.file(`${originalName}_slice_${indexStr}.png`, blob);
                   resolve();
                 } else {
                   reject(new Error(`Failed to create blob for slice ${row},${col}`));
                 }
               }, imageFile.type === 'image/jpeg' ? 'image/jpeg' : 'image/png');
           });
           slicePromises.push(slicePromise);
        }
      }

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
    } catch(e) {
      setError('Error zipping files');
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
                disabled={isProcessing || columns * rows <= 1}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-2"
              >
                {isProcessing ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Processing...</>
                ) : (
                  <>Download All ({columns * rows})</>
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
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-4">Grid Configuration</label>
                  <div className="space-y-6">
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium">Columns</span>
                        <span className="text-sm text-indigo-400 font-mono">{columns}</span>
                      </div>
                      <input
                        id="columns"
                        type="range"
                        min="1"
                        max="10"
                        value={columns}
                        onChange={(e) => setColumns(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium">Rows</span>
                        <span className="text-sm text-indigo-400 font-mono">{rows}</span>
                      </div>
                      <input
                        id="rows"
                        type="range"
                        min="1"
                        max="10"
                        value={rows}
                        onChange={(e) => setRows(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
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
                      <span>{columns * rows}</span>
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
                    <div className="relative shadow-2xl rounded shadow-black/50 group max-w-full max-h-full flex overflow-hidden bg-slate-900 checkerboard-bg">
                      <img
                        ref={imageElementRef}
                        src={imagePreviewUrl}
                        alt="Preview"
                        onLoad={handleImageLoad}
                        className="block max-w-full max-h-[calc(100vh-12rem)] object-contain transition-opacity duration-300 rounded"
                      />

                      {imageSize && (
                        <div 
                          className="absolute inset-0 pointer-events-none select-none transition-opacity duration-300 grid"
                          style={{
                            gridTemplateColumns: `repeat(${columns}, 1fr)`,
                            gridTemplateRows: `repeat(${rows}, 1fr)`,
                          }}
                        >
                           {Array.from({ length: columns * rows }).map((_, i) => (
                              <div 
                                key={i} 
                                className="border-[0.5px] border-white/40 border-dashed relative"
                              >
                                <span className="absolute top-1 left-1 text-[10px] bg-black/60 px-1 text-white">
                                  {i + 1}
                                </span>
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
                        className="grid gap-3 p-2 rounded-xl bg-[#1e293b]/80 shadow-2xl overflow-hidden w-full h-full"
                        style={{
                           gridTemplateColumns: `repeat(${columns}, 1fr)`,
                           gridTemplateRows: `repeat(${rows}, 1fr)`,
                           aspectRatio: imageSize ? `${imageSize.width} / ${imageSize.height}` : 'auto',
                           maxHeight: '100%',
                           maxWidth: '100%',
                        }}
                      >
                         {Array.from({ length: columns * rows }).map((_, i) => {
                            const col = i % columns;
                            const row = Math.floor(i / columns);
                            const bgPosX = columns > 1 ? (col / (columns - 1)) * 100 : 0;
                            const bgPosY = rows > 1 ? (row / (rows - 1)) * 100 : 0;
                            return (
                              <div 
                                key={i} 
                                className="relative overflow-hidden rounded bg-[#0f172a] checkerboard-bg transform transition-transform hover:scale-[1.02] shadow-md border border-slate-700/50 hover:border-indigo-500 hover:shadow-indigo-500/20"
                                style={{
                                  backgroundImage: `url(${imagePreviewUrl})`,
                                  backgroundSize: `${columns * 100}% ${rows * 100}%`,
                                  backgroundPosition: `${bgPosX}% ${bgPosY}%`
                                }}
                              >
                                <span className="absolute top-1 left-1 text-[10px] bg-black/70 px-1.5 py-0.5 rounded text-white shadow-sm pointer-events-none backdrop-blur-sm">
                                  {i + 1}
                                </span>
                              </div>
                            );
                         })}
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

                      <div className="p-3 border-t border-slate-700 bg-slate-800 flex justify-between items-center">
                        <span className="text-xs truncate text-slate-300 font-medium" title={file.file.name}>{file.file.name}</span>
                        {file.status === 'done' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
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
             <span>Pieces: {columns * rows}</span>
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

