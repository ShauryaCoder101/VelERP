module.exports = [
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/action-async-storage.external.js [external] (next/dist/server/app-render/action-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/action-async-storage.external.js", () => require("next/dist/server/app-render/action-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[project]/lib/auth.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "currentUser",
    ()=>currentUser,
    "teamMembers",
    ()=>teamMembers
]);
const currentUser = {
    name: "Aril Sharma",
    role: "Managing Director",
    uid: "MD-001",
    designation: "Managing Director",
    email: "arils@velocityindia.net"
};
const teamMembers = [
    currentUser,
    {
        name: "Shaurya Sharma",
        role: "Operations Team Member",
        uid: "OPS-001",
        designation: "Operations Team Member",
        team: "Ops Team",
        email: "shaurya@velocityindia.net"
    }
];
}),
"[project]/lib/navigation.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "NAV_LINKS",
    ()=>NAV_LINKS
]);
const NAV_LINKS = [
    {
        label: "My Dashboard",
        href: "/",
        minLevel: 4
    },
    {
        label: "Events",
        href: "/events",
        minLevel: 3
    },
    {
        label: "Vendor Management",
        href: "/vendor-management",
        minLevel: 2
    },
    {
        label: "Expense Claims",
        href: "/expense-claims",
        minLevel: 3
    },
    {
        label: "Event Uploads",
        href: "/event-uploads",
        minLevel: 3
    },
    {
        label: "Team",
        href: "/team",
        minLevel: 2
    }
];
}),
"[project]/lib/rbac.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ROLE_LEVELS",
    ()=>ROLE_LEVELS,
    "ROLE_LEVEL_GROUPS",
    ()=>ROLE_LEVEL_GROUPS,
    "getRoleLevel",
    ()=>getRoleLevel,
    "hasAccess",
    ()=>hasAccess
]);
const ROLE_LEVELS = {
    "Managing Director": 1,
    "Head of Operations": 2,
    "Head of Special Projects": 2,
    "Growth Partner": 2,
    "Operations Team Member": 3,
    "Research and Development Team Member": 3,
    Intern: 4,
    Assistant: 4,
    Freelancer: 4
};
const ROLE_LEVEL_GROUPS = {
    1: [
        "Managing Director"
    ],
    2: [
        "Head of Operations",
        "Head of Special Projects",
        "Growth Partner"
    ],
    3: [
        "Operations Team Member",
        "Research and Development Team Member"
    ],
    4: [
        "Intern",
        "Assistant",
        "Freelancer"
    ]
};
const getRoleLevel = (role)=>ROLE_LEVELS[role];
const hasAccess = (role, minLevel)=>getRoleLevel(role) <= minLevel;
}),
"[project]/app/components/SidebarNav.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>SidebarNav
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/app-dir/link.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/navigation.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$auth$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/auth.ts [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$navigation$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/navigation.ts [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$rbac$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/rbac.ts [app-ssr] (ecmascript)");
"use client";
;
;
;
;
;
;
function SidebarNav() {
    const pathname = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["usePathname"])();
    const visibleLinks = __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$navigation$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["NAV_LINKS"].filter((link)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$rbac$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["hasAccess"])(__TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$auth$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["currentUser"].role, link.minLevel));
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("nav", {
        className: "sidebar-nav",
        children: visibleLinks.map((link)=>{
            const isActive = pathname === link.href;
            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["default"], {
                href: link.href,
                className: `nav-item hover-text${isActive ? " active" : ""}`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "nav-icon",
                        "aria-hidden": "true"
                    }, void 0, false, {
                        fileName: "[project]/app/components/SidebarNav.tsx",
                        lineNumber: 23,
                        columnNumber: 13
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        children: link.label
                    }, void 0, false, {
                        fileName: "[project]/app/components/SidebarNav.tsx",
                        lineNumber: 24,
                        columnNumber: 13
                    }, this)
                ]
            }, link.href, true, {
                fileName: "[project]/app/components/SidebarNav.tsx",
                lineNumber: 18,
                columnNumber: 11
            }, this);
        })
    }, void 0, false, {
        fileName: "[project]/app/components/SidebarNav.tsx",
        lineNumber: 14,
        columnNumber: 5
    }, this);
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__98eecf04._.js.map