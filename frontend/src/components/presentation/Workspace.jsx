import React,{createContext,useContext,useMemo,useState} from 'react';
import {createPortal} from 'react-dom';
const Context=createContext(null);
export function WorkspaceProvider({children}){const [fieldHost,setFieldHost]=useState(null);const [panel,setPanel]=useState('devices');const [collapsed,setCollapsed]=useState(false);const value=useMemo(()=>({fieldHost,setFieldHost,panel,setPanel,collapsed,setCollapsed}),[fieldHost,panel,collapsed]);return <Context.Provider value={value}>{children}</Context.Provider>;}
export const useWorkspace=()=>useContext(Context);
export function FieldControlSlot({children}){const w=useWorkspace();return w?.fieldHost?createPortal(children,w.fieldHost):children;}
