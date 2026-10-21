// nofocus.dylib —— 用 DYLD_INSERT_LIBRARIES 注入 session 跑的 Godot（與 chrome-bg 的 Chrome 副本），讓它永遠不搶焦點、視窗開在最底層。
//
// 為什麼：Godot 啟動與換場景時會自己 activate，open -g、no_focus 都擋不住；
// 事後切回（bgrun、focus-keeper）還是會閃 0.2–0.4 秒，使用者兩次說「還是會彈出」（2026-10-11）。
// 這支從根本拿掉：activate 類呼叫變成什麼都不做，orderFront 類改成 orderBack。
// Godot.app 的簽章帶 allow-dyld-environment-variables 與 disable-library-validation，所以注入得進去。
// 2026-10-11 使用者明確授權這個注入。只經由 godot-bg 套用，使用者自己開的 Godot 不受影響。
// animyria 的截圖是 viewport 的 get_image，不是截螢幕，所以視窗在最底層照樣出圖。
//
// 建置：./build.sh（產 nofocus.dylib，不進版控）。
#import <objc/runtime.h>
#import <objc/message.h>
#import <mach-o/dyld.h>

static void noop_bool(id self, SEL _cmd, BOOL b) {}
static void noop(id self, SEL _cmd) {}
static BOOL noop_opts(id self, SEL _cmd, unsigned long o) { return YES; }
static void to_back(id self, SEL _cmd, id sender) {
  ((void (*)(id, SEL, id))objc_msgSend)(self, sel_registerName("orderBack:"), sender);
}
static void to_back0(id self, SEL _cmd) {
  ((void (*)(id, SEL, id))objc_msgSend)(self, sel_registerName("orderBack:"), nil);
}

static void swap(const char *cls, const char *sel, IMP imp) {
  Class c = objc_getClass(cls);
  if (!c) return;
  Method m = class_getInstanceMethod(c, sel_registerName(sel));
  if (m) method_setImplementation(m, imp);
}

static void swap_all(void) {
  swap("NSApplication", "activateIgnoringOtherApps:", (IMP)noop_bool);
  swap("NSApplication", "activate", (IMP)noop);
  swap("NSRunningApplication", "activateWithOptions:", (IMP)noop_opts);
  swap("NSRunningApplication", "activateFromApplication:options:", (IMP)noop_opts);
  swap("NSWindow", "makeKeyAndOrderFront:", (IMP)to_back);
  swap("NSWindow", "orderFront:", (IMP)to_back);
  swap("NSWindow", "orderFrontRegardless", (IMP)to_back0);
}

// Chrome 的主執行檔只是個殼，AppKit 要等它 dlopen 自己的 framework 才載入；constructor 當下
// NSApplication 還不存在，swap 會安靜地什麼都沒做（2026-10-15 實測：dylib 有載入、Chrome 照搶）。
// 所以每載入一個新 image 就再 swap 一次（method_setImplementation 重複設同一個值沒有副作用）。
static void on_image(const struct mach_header *mh, intptr_t slide) { swap_all(); }

__attribute__((constructor)) static void nofocus_init(void) {
  swap_all();
  _dyld_register_func_for_add_image(on_image);
}
